import { db, newId } from './db'
import { queue, removeStock, type Ctx } from './repo'
import { can } from '../domain/permissions'
import { expiredQuantity, expiryRows, summarizeExpiry, validExpiry, type BatchRecord, type ExpiryRow } from '../domain/expiry'

export const DEFAULT_EXPIRY_WARN_DAYS = 30
const WARN_KEY = 'expiryWarnDays'

/**
 * Record that `baseQty` units of a product came in expiring on `expiry` (yyyy-mm-dd). Must run inside a transaction that includes the
 * products, stockBatches and outbox tables, in the same upload group as the stock movement it belongs to.
 */
export async function recordBatchInTx(ctx: Ctx, productId: string, baseQty: number, expiry: string, groupId: string): Promise<BatchRecord> {
  const p = await db.products.get(productId)
  if (!p) throw new Error('product not found')
  if (!p.trackExpiry) throw new Error('this product does not track expiry dates')
  if (!validExpiry(expiry, new Date())) throw new Error('the expiry date is not valid (yyyy-mm-dd)')
  if (!Number.isInteger(baseQty) || baseQty <= 0) throw new Error('quantity must be a positive whole number')
  const b: BatchRecord = { id: newId(), tenantId: ctx.tenantId, shopId: ctx.shopId, productId, expiry, quantity: baseQty, receivedAt: new Date().toISOString(), recordedBy: ctx.userId }
  await db.stockBatches.add(b)
  await queue('stock_batches', b, groupId)
  return b
}

export async function loadWarnDays(): Promise<number> {
  return ((await db.meta.get(WARN_KEY))?.value as number | undefined) ?? DEFAULT_EXPIRY_WARN_DAYS
}
export async function saveWarnDays(days: number): Promise<void> {
  await db.meta.put({ key: WARN_KEY, value: Math.min(Math.max(Math.floor(days), 1), 365) })
}

/** Expired and soon-to-expire stock of the current shop, soonest first. */
export async function loadExpiry(ctx: Ctx, today = new Date()): Promise<{ rows: ExpiryRow[]; warnDays: number }> {
  const warnDays = await loadWarnDays()
  const [products, costs, batches] = await Promise.all([db.products.toArray(), db.costs.where('shopId').equals(ctx.shopId).toArray(), db.stockBatches.where('shopId').equals(ctx.shopId).toArray()])
  const cost = new Map(costs.map((c) => [c.productId, c]))
  const rows = expiryRows(
    products.map((p) => {
      const c = cost.get(p.id)
      return { id: p.id, name: p.name, baseUnit: p.baseUnit, trackExpiry: Boolean(p.trackExpiry), active: p.active, onHand: c?.quantity ?? 0, avgCost: c && c.quantity > 0 ? Math.round(c.value / c.quantity) : (c?.lastUnitCost ?? 0) }
    }),
    batches, today, warnDays,
  )
  return { rows, warnDays }
}

export { summarizeExpiry }

/**
 * Write off the expired units of one product as an ordinary "expired" removal (stock and its value go down by what the units cost).
 * Because the oldest goes first, this consumes exactly the expired batches. Returns how many units were removed.
 */
export async function writeOffExpired(ctx: Ctx, productId: string, today = new Date()): Promise<number> {
  if (!can(ctx.role, 'stock.adjust_approve')) throw new Error('not allowed to write off stock')
  const [cost, batches] = await Promise.all([db.costs.get(`${ctx.shopId}:${productId}`), db.stockBatches.where('shopId').equals(ctx.shopId).filter((b) => b.productId === productId).toArray()])
  const qty = expiredQuantity(cost?.quantity ?? 0, batches, today)
  if (qty <= 0) return 0
  await removeStock(ctx, productId, qty, 'expired', 'expired (best-before date passed)')
  return qty
}

export async function writeOffAllExpired(ctx: Ctx, today = new Date()): Promise<{ products: number; units: number }> {
  const { rows } = await loadExpiry(ctx, today)
  const ids = [...new Set(rows.filter((r) => r.status === 'expired').map((r) => r.productId))]
  let units = 0
  for (const id of ids) units += await writeOffExpired(ctx, id, today)
  return { products: ids.length, units }
}
