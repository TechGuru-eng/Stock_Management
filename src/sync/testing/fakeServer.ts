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
  /** Tests may plug these in to watch support reports. */
  reportIssue?: SyncTransport['reportIssue']
  resolveIssue?: SyncTransport['resolveIssue']
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

  /** Who each upload was made for (undefined = the signed-in session itself). Tests may restrict who is allowed. */
  pushedAs: (string | undefined)[] = []
  allowedActors: Set<string> | null = null

  async push(deviceId: string, ops: WireOp[], actorId?: string) {
    this.pushCalls++
    if (actorId && this.allowedActors && !this.allowedActors.has(actorId)) throw new TransportError('permanent', 'unknown or inactive person for this device', '42501')
    this.pushedAs.push(actorId)
    if (!this.online || this.pushFails) throw new TransportError('network', 'Failed to fetch')
    if (this.revoked.has(deviceId)) throw new TransportError('permanent', 'this device has been revoked', '42501')

    const draft: Record<string, Table> = Object.fromEntries(
      Object.entries(this.tables).map(([k, v]) => [k, new Map(v)]),
    )
    const draftOps = new Set<string>()
    const salesInBatch: string[] = []
    const paymentsInBatch: string[] = []
    const receiptsInBatch: string[] = []
    const returnsInBatch: string[] = []
    const transfersInBatch = new Set<string>()
    const decisionsInBatch: string[] = []
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
      if (op.table === 'goods_receipts') receiptsInBatch.push(row.id as string)
      if (op.table === 'sale_returns') returnsInBatch.push(row.id as string)
      if (op.table === 'stock_count_lines' && [...draft.stock_count_decisions.values()].some((d) => d.row.count_id === row.count_id)) {
        throw new TransportError('permanent', 'this count has already been decided', '23514')
      }
      if (op.table === 'stock_count_decisions') decisionsInBatch.push(row.id as string)
      if (op.table === 'stock_movements' && (row.movement_type === 'transfer_in' || row.movement_type === 'transfer_out')) transfersInBatch.add(`${row.reference_id}|${row.product_id}`)
      if (op.table === 'product_edit' || op.table === 'unit_edit') {
        const fail = (m: string, code = '23514') => { throw new TransportError('permanent', m, code) }
        const { before: _before, id, tenant_id: _t, ...fields } = row as Record<string, unknown>
        void _before; void _t
        if (op.table === 'product_edit') {
          const prod = draft.products.get(id as string)?.row
          if (!prod) fail('product not found')
          if ('name' in fields && String(fields.name).trim().length < 1) fail('name: 1 to 120 characters')
          if ('min_stock' in fields && Number(fields.min_stock) < 0) fail('minimum stock cannot be negative')
          if ('tax_rate_bp' in fields && (Number(fields.tax_rate_bp) < 0 || Number(fields.tax_rate_bp) > 10000)) fail('tax rate out of range')
          if (fields.barcode && [...draft.products.values()].some((x) => x.row.id !== id && x.row.barcode === fields.barcode)) fail('duplicate key value violates unique constraint', '23505')
          draft.products.set(id as string, { row: { ...prod!, ...fields }, changed: this.tick() })
        } else {
          const unit = draft.product_units.get(id as string)?.row
          if (!unit) fail('unit not found')
          if ('sell_price' in fields && Number(fields.sell_price) < 0) fail('price cannot be negative')
          draft.product_units.set(id as string, { row: { ...unit!, ...fields }, changed: this.tick() })
        }
        applied++
        continue
      }
      if (op.table === 'product_barcode') {
        const prod = draft.products.get(row.id as string)?.row
        if (!prod || prod.barcode) throw new TransportError('permanent', 'product not found, or it already has a barcode', '23514')
        if ([...draft.products.values()].some((x) => x.row.barcode === row.barcode)) throw new TransportError('permanent', 'duplicate key value violates unique constraint', '23505')
        draft.products.set(row.id as string, { row: { ...prod, barcode: row.barcode }, changed: this.tick() })
        applied++
        continue
      }
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

    // Same rules as check_receipt_consistency(): stock and debt follow what was received, never more than ordered.
    for (const id of receiptsInBatch) {
      const sum = (rs: Row[], k: string) => rs.reduce((t, r) => t + Number(r[k]), 0)
      const fail = (m: string) => {
        throw new TransportError('permanent', `receipt ${id}: ${m}`, '23514')
      }
      const lines = [...draft.goods_receipt_lines.values()].map((v) => v.row).filter((l) => l.receipt_id === id)
      if (lines.length === 0) fail('has no lines')
      const entries = [...draft.supplier_account_entries.values()].map((v) => v.row).filter((e) => e.receipt_id === id && e.kind === 'purchase_credit')
      if (sum(entries, 'amount') !== sum(lines, 'total_cost')) fail('supplier debt does not match the value received')
      const moved = [...draft.stock_movements.values()].map((v) => v.row).filter((m) => m.reference_id === id && m.movement_type === 'purchase_receipt')
      if (sum(moved, 'quantity') !== sum(lines, 'base_quantity')) fail('stock does not match the quantities received')
      for (const l of lines) {
        const ordered = Number(draft.purchase_lines.get(l.purchase_line_id as string)?.row.base_quantity)
        const total = [...draft.goods_receipt_lines.values()].map((v) => v.row).filter((x) => x.purchase_line_id === l.purchase_line_id)
        if (sum(total, 'base_quantity') > ordered) fail('more received than ordered')
      }
    }

    // Same rules as check_return_consistency().
    for (const id of returnsInBatch) {
      const rt = draft.sale_returns.get(id)!.row
      const sum = (rs: Row[], k: string) => rs.reduce((t, r) => t + Number(r[k]), 0)
      const fail = (m: string) => {
        throw new TransportError('permanent', `return ${id}: ${m}`, '23514')
      }
      const lines = [...draft.sale_return_lines.values()].map((v) => v.row).filter((l) => l.return_id === id)
      if (lines.length === 0) fail('has no lines')
      if (sum(lines, 'value') !== Number(rt.total_value)) fail('lines do not add up to the total')
      if (Number(rt.refunded_amount) + Number(rt.debt_reduced) !== Number(rt.total_value)) fail('refund and debt do not add up to the total')
      const txns = [...draft.financial_transactions.values()].map((v) => v.row).filter((t) => t.return_id === id)
      if (sum(txns, 'amount') !== -Number(rt.refunded_amount)) fail('money paid back does not match the refund')
      const entries = [...draft.customer_account_entries.values()].map((v) => v.row).filter((e) => e.return_id === id)
      if (sum(entries, 'amount') !== -Number(rt.debt_reduced)) fail('customer balance entry does not match')
      const moved = [...draft.stock_movements.values()].map((v) => v.row).filter((m) => m.reference_id === id && m.movement_type === 'return_in')
      if (sum(moved, 'quantity') !== sum(lines.filter((l) => l.restock), 'base_quantity')) fail('stock does not match the goods put back')
      const allLines = [...draft.sale_return_lines.values()].map((v) => v.row)
      for (const l of lines) {
        const sold = Number(draft.sale_lines.get(l.sale_line_id as string)?.row.quantity)
        if (sum(allLines.filter((x) => x.sale_line_id === l.sale_line_id), 'quantity') > sold + 1e-9) fail('more returned than was sold')
      }
      const mine = [...draft.sale_returns.values()].map((v) => v.row).filter((x) => x.sale_id === rt.sale_id)
      const paid = sum([...draft.financial_transactions.values()].map((v) => v.row).filter((t) => t.sale_id === rt.sale_id && t.txn_type === 'sale_collection'), 'amount')
        + sum([...draft.payment_allocations.values()].map((v) => v.row).filter((a) => a.sale_id === rt.sale_id), 'amount')
      if (sum(mine, 'refunded_amount') > paid) fail('refunds exceed what the customer paid')
      if (sum(mine, 'debt_reduced') > Number(draft.sales.get(rt.sale_id as string)?.row.outstanding)) fail('debt written off exceeds what was owed')
    }

    // Same rules as check_count_decision() and check_count_adjustment().
    for (const id of decisionsInBatch) {
      const d = draft.stock_count_decisions.get(id)!.row
      const c = draft.stock_counts.get(d.count_id as string)?.row
      const fail = (m: string) => {
        throw new TransportError('permanent', `count ${d.count_id}: ${m}`, '23514')
      }
      if (!c) fail('unknown count')
      const moved = [...draft.stock_movements.values()].map((v) => v.row).filter((m) => m.reference_id === d.count_id && m.movement_type === 'count_adjustment')
      if (d.decision === 'rejected') {
        if (moved.length) fail('a rejected count cannot adjust stock')
        continue
      }
      const newest = new Map<string, Row>()
      for (const l of [...draft.stock_count_lines.values()].map((v) => v.row).filter((l) => l.count_id === d.count_id)) {
        const cur = newest.get(l.product_id as string)
        if (!cur || String(l.counted_at) > String(cur.counted_at) || (l.counted_at === cur.counted_at && String(l.id) > String(cur.id))) newest.set(l.product_id as string, l)
      }
      for (const [product, l] of newest) {
        const diff = Number(l.counted) - Number(l.expected)
        const mine = moved.filter((m) => m.product_id === product)
        if (diff === 0 ? mine.length > 0 : mine.length !== 1 || Number(mine[0].quantity) !== diff) fail('adjustment does not match the count')
      }
      if (moved.some((m) => !newest.has(m.product_id as string) || m.shop_id !== c!.shop_id)) fail('adjustment for something that was not counted')
    }
    for (const row of [...draft.stock_movements.values()].map((v) => v.row)) {
      if (row.movement_type !== 'count_adjustment' || !draftOps.size) continue
      const ok = [...draft.stock_count_decisions.values()].some((d) => d.row.count_id === row.reference_id && d.row.decision === 'approved')
      if (!ok) throw new TransportError('permanent', 'a stock adjustment must come from an approved count', '23514')
    }

    // Same rules as check_transfer_consistency(): one out and one in, same product, quantity and value, two shops.
    for (const key of transfersInBatch) {
      const [ref, product] = key.split('|')
      const fail = (m: string) => {
        throw new TransportError('permanent', `transfer ${ref}: ${m}`, '23514')
      }
      if (ref === 'null' || ref === 'undefined') fail('needs a reference shared by both sides')
      const rows = [...draft.stock_movements.values()].map((v) => v.row).filter((m) => m.reference_id === ref && m.product_id === product && (m.movement_type === 'transfer_in' || m.movement_type === 'transfer_out'))
      const outs = rows.filter((m) => m.movement_type === 'transfer_out')
      const ins = rows.filter((m) => m.movement_type === 'transfer_in')
      if (rows.length !== 2 || outs.length !== 1 || ins.length !== 1) fail('does not balance: one out and one in')
      if (Number(outs[0].quantity) + Number(ins[0].quantity) !== 0) fail('quantity does not balance')
      if (Number(outs[0].total_cost) !== Number(ins[0].total_cost)) fail('value does not balance')
      if (outs[0].shop_id === ins[0].shop_id) fail('needs two different shops')
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
