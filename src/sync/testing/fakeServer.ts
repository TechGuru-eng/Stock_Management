import { SYNC_TABLES } from '../mappers'
import { TransportError, type PullResponse, type SyncTransport, type WireOp } from '../transport'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Table = Map<string, { row: Row; changed: string }>

/**
 * In-memory stand-in for the Supabase sync functions. It reproduces the behaviours
 * the engine depends on: idempotent operation ids, atomic groups, the same
 * consistency checks as check_sale_consistency(), device revocation and the
 * paged change feed. Tests only.
 */
export class FakeServer implements SyncTransport {
  online = true
  /** Registration and downloads work, but uploads fail (flaky connection). */
  pushFails = false
  /** Apply the group, then drop the connection before the reply (the dangerous case). */
  failAfterApply = false
  /** Force small pages to exercise pagination. */
  pageLimit?: number
  revoked = new Set<string>()
  tables: Record<string, Table> = Object.fromEntries(SYNC_TABLES.map((t) => [t, new Map()]))
  processed = new Set<string>()
  pushCalls = 0
  private clock = Date.parse('2026-01-01T00:00:00Z')

  private tick() {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }

  count(table: string) {
    return this.tables[table].size
  }
  rows(table: string): Row[] {
    return [...this.tables[table].values()].map((v) => v.row)
  }

  async registerDevice(deviceId: string) {
    if (!this.online) throw new TransportError('network', 'offline')
    if (this.revoked.has(deviceId)) throw new TransportError('permanent', 'this device is not allowed to sync', '42501')
  }

  async push(deviceId: string, ops: WireOp[]) {
    this.pushCalls++
    if (!this.online || this.pushFails) throw new TransportError('network', 'Failed to fetch')
    if (this.revoked.has(deviceId)) throw new TransportError('permanent', 'this device has been revoked', '42501')

    const draft: Record<string, Table> = Object.fromEntries(
      Object.entries(this.tables).map(([k, v]) => [k, new Map(v)]),
    )
    const draftOps = new Set<string>()
    const salesInBatch: string[] = []
    const paymentsInBatch: string[] = []
    let applied = 0
    let skipped = 0

    for (const op of ops) {
      if (this.processed.has(op.op_id) || draftOps.has(op.op_id)) {
        skipped++
        continue
      }
      draftOps.add(op.op_id)
      const row = { ...op.payload } as Row
      if (op.table === 'products' && row.barcode) {
        for (const e of draft.products.values()) {
          if (e.row.barcode === row.barcode && e.row.tenant_id === row.tenant_id && e.row.id !== row.id) {
            throw new TransportError('permanent', 'duplicate key value violates unique constraint "products_barcode_uq"', '23505')
          }
        }
      }
      if (op.table === 'sale_lines') {
        const unit = draft.product_units.get(row.unit_id as string)?.row
        if (!unit) throw new TransportError('permanent', 'unknown unit for product', '23503')
        if (Math.round(Number(row.quantity) * Number(unit.factor)) !== Number(row.base_quantity)) {
          throw new TransportError('permanent', 'unit conversion mismatch', '23514')
        }
      }
      if (op.table === 'sales') salesInBatch.push(row.id as string)
      if (op.table === 'payments') paymentsInBatch.push(row.id as string)
      draft[op.table].set(row.id as string, { row, changed: this.tick() })
      applied++
    }

    // Same rules as check_sale_consistency(), evaluated once the whole group is in.
    for (const id of salesInBatch) {
      const sale = draft.sales.get(id)!.row
      const lines = [...draft.sale_lines.values()].map((v) => v.row).filter((l) => l.sale_id === id)
      const sum = (rs: Row[], k: string) => rs.reduce((t, r) => t + Number(r[k]), 0)
      const fail = (m: string) => {
        throw new TransportError('permanent', `sale ${sale.sale_number}: ${m}`, '23514')
      }
      if (lines.length === 0) fail('has no lines')
      if (sum(lines, 'line_total') !== Number(sale.total)) fail('lines do not add up to the total')
      const txns = [...draft.financial_transactions.values()].map((v) => v.row).filter((t) => t.sale_id === id)
      if (sum(txns, 'amount') !== Number(sale.collected)) fail('payments do not match collected')
      const entries = [...draft.customer_account_entries.values()].map((v) => v.row).filter((e) => e.sale_id === id)
      if (sum(entries, 'amount') !== Number(sale.outstanding)) fail('debt does not match outstanding')
      const moved = [...draft.stock_movements.values()].map((v) => v.row).filter((m) => m.reference_id === id && m.movement_type === 'sale')
      if (-sum(moved, 'quantity') !== sum(lines, 'base_quantity')) fail('stock does not match sold quantities')
    }

    // Same rules as check_payment_consistency().
    for (const id of paymentsInBatch) {
      const p = draft.payments.get(id)!.row
      const sum = (rs: Row[], k: string) => rs.reduce((t, r) => t + Number(r[k]), 0)
      const fail = (m: string) => {
        throw new TransportError('permanent', `payment ${id}: ${m}`, '23514')
      }
      const allocs = [...draft.payment_allocations.values()].map((v) => v.row).filter((a) => a.payment_id === id)
      if (sum(allocs, 'amount') !== Number(p.amount)) fail('allocations do not add up to the amount')
      const txn = draft.financial_transactions.get(p.transaction_id as string)?.row
      if (!txn || Number(txn.amount) !== Number(p.amount) || txn.txn_type !== 'debt_repayment') fail('money entry does not match')
      const entries = [...draft.customer_account_entries.values()].map((v) => v.row).filter((e) => e.transaction_id === p.transaction_id)
      if (sum(entries, 'amount') !== -Number(p.amount)) fail('customer balance entry does not match')
    }

    this.tables = draft
    draftOps.forEach((o) => this.processed.add(o))
    if (this.failAfterApply) throw new TransportError('network', 'connection lost before the reply')
    return { applied, skipped }
  }

  async pull(since: string, limit: number): Promise<PullResponse> {
    if (!this.online) throw new TransportError('network', 'Failed to fetch')
    const page = this.pageLimit ?? limit
    const rows: Record<string, Row[]> = {}
    let overall = since
    let truncated: string | undefined
    for (const t of SYNC_TABLES) {
      const hits = [...this.tables[t].values()]
        .filter((e) => e.changed > since)
        .sort((a, b) => (a.changed < b.changed ? -1 : 1))
        .slice(0, page)
      rows[t] = hits.map((h) => ({ ...h.row }))
      if (hits.length) {
        const mx = hits[hits.length - 1].changed
        if (mx > overall) overall = mx
        if (hits.length >= page) truncated = truncated === undefined || mx < truncated ? mx : truncated
      }
    }
    return {
      rows,
      cursor: truncated ?? overall,
      has_more: truncated !== undefined,
      server_time: new Date(this.clock).toISOString(),
      subscription: null,
    }
  }
}
