import { db, deviceId, type OutboxRec } from '../data/db'
import { rebuildCosts } from '../data/projection'
import { fromServer, SYNC_TABLES, toServer, type SyncTable } from './mappers'
import { TransportError, type PullResponse, type SyncTransport } from './transport'

export interface SyncContext {
  tenantId: string
  deviceName: string
}

export interface SyncRunResult {
  /** Groups (business events) uploaded successfully in this run. */
  pushedGroups: number
  /** Rows downloaded from other devices in this run. */
  pulledRows: number
  /** True when the run stopped because the server could not be reached. */
  offline: boolean
  /** True when this device was revoked by the owner. */
  revoked: boolean
  error?: string
}

/* ------------------------------ engine state ------------------------------ */

export interface EngineSnapshot {
  running: boolean
  lastError?: string
  revoked: boolean
}

let snapshot: EngineSnapshot = { running: false, revoked: false }
const listeners = new Set<() => void>()

function setSnapshot(patch: Partial<EngineSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((l) => l())
}
export const getEngineSnapshot = () => snapshot
export function subscribeEngine(l: () => void) {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/* --------------------------------- helpers -------------------------------- */

const EPOCH = '1970-01-01T00:00:00.000Z'
/** Rows committed on the server a moment "late" must not be missed: re-ask for a short overlap. */
const PULL_OVERLAP_MS = 2 * 60_000
const PULL_PAGE = 500
const BACKOFF_BASE_MS = 5_000
const BACKOFF_MAX_MS = 15 * 60_000

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_MAX_MS)
}

async function log(groupId: string, outcome: 'ok' | 'network' | 'rejected' | 'conflict', message?: string) {
  await db.syncLog.add({ groupId, at: new Date().toISOString(), outcome, message })
}

async function setGroup(groupId: string, patch: Partial<OutboxRec>) {
  await db.outbox.where('groupId').equals(groupId).modify(patch)
}

/* ---------------------------------- push ---------------------------------- */

async function pushAll(transport: SyncTransport, manual: boolean): Promise<{ groups: number; offline: boolean; error?: string }> {
  const rows = await db.outbox.orderBy('seq').toArray()
  const groups = new Map<string, OutboxRec[]>()
  for (const r of rows) groups.set(r.groupId, [...(groups.get(r.groupId) ?? []), r])

  let pushed = 0
  for (const [groupId, rs] of groups) {
    if (rs[0].status !== 'pending') continue // waits for a person to retry or resolve it
    const due = rs[0].nextAttemptAt
    if (!manual && due && Date.parse(due) > Date.now()) return { groups: pushed, offline: true }

    try {
      await transport.push(
        deviceId(),
        rs.map((r) => ({ op_id: r.id, table: r.table, payload: toServer(r.table, r.payload as Record<string, unknown>) })),
      )
      await db.outbox.where('groupId').equals(groupId).delete()
      await log(groupId, 'ok')
      pushed++
    } catch (e) {
      const err = e instanceof TransportError ? e : new TransportError('network', (e as Error).message)
      if (err.kind === 'permanent') {
        const status = err.code === '23505' ? 'conflict' : 'rejected'
        await setGroup(groupId, { status, lastError: err.message, nextAttemptAt: undefined })
        await log(groupId, status, err.message)
        continue // independent groups can still go through
      }
      // Network or expired session: nothing is lost. Keep the data, retry later.
      const attempts = rs[0].attempts + 1
      await setGroup(groupId, {
        attempts,
        lastError: err.message,
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)).toISOString(),
      })
      await log(groupId, 'network', err.message)
      // Later groups may depend on this one, so stop and keep the order.
      return { groups: pushed, offline: true, error: err.message }
    }
  }
  return { groups: pushed, offline: false }
}

/* ---------------------------------- pull ---------------------------------- */

async function applyPull(res: PullResponse): Promise<number> {
  const pendingIds = new Set(
    (await db.outbox.toArray()).map((o) => (o.payload as { id?: string }).id).filter((x): x is string => Boolean(x)),
  )
  const touched: { shopId: string; productId: string }[] = []
  let count = 0

  await db.transaction(
    'rw',
    [
      db.products, db.units, db.customers, db.movements, db.sales, db.saleLines, db.transactions, db.customerEntries,
      db.payments, db.allocations, db.expenses, db.cashSessions, db.cashClosures,
      db.suppliers, db.purchases, db.purchaseLines, db.receipts, db.receiptLines, db.supplierEntries,
      db.saleReturns, db.returnLines, db.approvalRequests, db.approvalDecisions,
    ],
    async () => {
      const stores = {
        products: db.products, product_units: db.units, customers: db.customers, stock_movements: db.movements,
        sales: db.sales, sale_lines: db.saleLines, financial_transactions: db.transactions,
        customer_account_entries: db.customerEntries, payments: db.payments, payment_allocations: db.allocations,
        expenses: db.expenses, cash_sessions: db.cashSessions, cash_session_closures: db.cashClosures,
        suppliers: db.suppliers, purchases: db.purchases, purchase_lines: db.purchaseLines,
        goods_receipts: db.receipts, goods_receipt_lines: db.receiptLines, supplier_account_entries: db.supplierEntries,
        sale_returns: db.saleReturns, sale_return_lines: db.returnLines, approval_requests: db.approvalRequests,
        approval_decisions: db.approvalDecisions,
      } as const
      const mutable = new Set<SyncTable>(['products', 'product_units', 'customers'])

      for (const table of SYNC_TABLES) {
        const incoming = res.rows[table] ?? []
        if (incoming.length === 0) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = stores[table] as any
        const mapped = incoming.map((r) => fromServer(table, r)) as { id: string }[]
        const existing = await store.bulkGet(mapped.map((m: { id: string }) => m.id))

        const toWrite: unknown[] = []
        mapped.forEach((m: { id: string }, i: number) => {
          if (existing[i]) {
            // Append-only records never change. Editable ones take the server copy,
            // unless this device has its own unsent change for the same record.
            if (mutable.has(table) && !pendingIds.has(m.id)) toWrite.push(m)
            return
          }
          toWrite.push(m)
          if (table === 'stock_movements') {
            const mv = m as unknown as { shopId: string; productId: string }
            touched.push({ shopId: mv.shopId, productId: mv.productId })
          }
        })

        if (table === 'sale_lines') {
          for (const l of toWrite as { productId: string; unitId: string; productName: string; unitName: string }[]) {
            l.productName = (await db.products.get(l.productId))?.name ?? ''
            l.unitName = (await db.units.get(l.unitId))?.name ?? ''
          }
        }
        await store.bulkPut(toWrite)
        count += toWrite.length
      }
    },
  )
  // The stock projection is rebuilt from the ledger, never patched.
  await rebuildCosts(touched)
  return count
}

async function pullAll(transport: SyncTransport): Promise<number> {
  const saved = ((await db.meta.get('syncCursor'))?.value as string | undefined) ?? EPOCH
  let since = new Date(Math.max(Date.parse(saved) - PULL_OVERLAP_MS, 0)).toISOString()
  let total = 0
  let last: PullResponse | undefined
  for (let guard = 0; guard < 1000; guard++) {
    const res = await transport.pull(since, PULL_PAGE)
    total += await applyPull(res)
    last = res
    if (!res.has_more) break
    since = res.cursor
  }
  if (last) {
    await db.meta.put({ key: 'syncCursor', value: last.cursor })
    if (last.subscription) await db.meta.put({ key: 'subscription', value: last.subscription })
  }
  return total
}

/* ----------------------------------- run ---------------------------------- */

let inFlight: Promise<SyncRunResult> | null = null

/**
 * One full synchronisation: upload pending business events, then download changes
 * from other devices. Only one run at a time; a second request joins the first.
 */
export function runSync(transport: SyncTransport, ctx: SyncContext, opts: { manual?: boolean } = {}): Promise<SyncRunResult> {
  if (inFlight) return inFlight
  inFlight = (async (): Promise<SyncRunResult> => {
    setSnapshot({ running: true })
    const result: SyncRunResult = { pushedGroups: 0, pulledRows: 0, offline: false, revoked: false }
    try {
      try {
        await transport.registerDevice(deviceId(), ctx.tenantId, ctx.deviceName)
      } catch (e) {
        if (e instanceof TransportError && e.kind === 'permanent') {
          result.revoked = true
          result.error = e.message
          setSnapshot({ revoked: true })
          return result
        }
        throw e
      }
      setSnapshot({ revoked: false })

      const push = await pushAll(transport, Boolean(opts.manual))
      result.pushedGroups = push.groups
      result.offline = push.offline
      result.error = push.error
      if (push.offline) return result

      result.pulledRows = await pullAll(transport)
      await db.meta.put({ key: 'lastSyncAt', value: new Date().toISOString() })
      return result
    } catch (e) {
      result.offline = true
      result.error = (e as Error).message
      return result
    } finally {
      setSnapshot({ running: false, lastError: result.error })
      inFlight = null
    }
  })()
  return inFlight
}

/* -------------------------- fixing what went wrong ------------------------- */

/** Put a refused or conflicting event back in the queue (attempts reset). */
export async function retryGroup(groupId: string): Promise<void> {
  await setGroup(groupId, { status: 'pending', attempts: 0, nextAttemptAt: undefined, lastError: undefined })
}

export async function retryAllFailed(): Promise<void> {
  const rows = await db.outbox.where('status').anyOf('rejected', 'conflict').toArray()
  for (const g of new Set(rows.map((r) => r.groupId))) await retryGroup(g)
}

/**
 * Resolution for "two devices created a product with the same barcode":
 * keep both products, but remove the barcode from the one that clashed, then upload it.
 * (The shop can set a different barcode afterwards.)
 */
export async function resolveBarcodeConflict(groupId: string): Promise<void> {
  await db.transaction('rw', [db.outbox, db.products], async () => {
    const rows = await db.outbox.where('groupId').equals(groupId).toArray()
    const productRow = rows.find((r) => r.table === 'products')
    if (!productRow) throw new Error('this item is not a product')
    const p = { ...(productRow.payload as { id: string; barcode?: string }), barcode: undefined }
    await db.outbox.update(productRow.seq!, { payload: p })
    await db.products.update(p.id, { barcode: undefined })
    await retryGroup(groupId)
  })
}
