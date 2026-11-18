import type { Xaf } from './money'

/**
 * Supplier price lists. What each supplier QUOTES for a product (per unit: bottle, carton...), kept as an append-only history,
 * compared with what was actually PAID on past deliveries. Pure rules, no screens or databases.
 */
export interface SupplierPriceRecord {
  id: string
  tenantId: string
  supplierId: string
  productId: string
  unitId: string
  /** Price of ONE of this unit, in FCFA. */
  price: Xaf
  source: 'manual' | 'import'
  recordedBy: string
  recordedAt: string
}

const k = (r: { supplierId: string; productId: string; unitId: string }) => `${r.supplierId}|${r.productId}|${r.unitId}`

/** The newest quote for each supplier / product / unit (ties settled by id so every device agrees). */
export function currentQuotes(records: readonly SupplierPriceRecord[]): Map<string, SupplierPriceRecord> {
  const best = new Map<string, SupplierPriceRecord>()
  for (const r of records) {
    const cur = best.get(k(r))
    if (!cur || r.recordedAt > cur.recordedAt || (r.recordedAt === cur.recordedAt && r.id > cur.id)) best.set(k(r), r)
  }
  return best
}

export const quoteKey = k

/** Every quote for one supplier / product / unit, newest first (the history). */
export function quoteHistory(records: readonly SupplierPriceRecord[], ref: { supplierId: string; productId: string; unitId: string }): SupplierPriceRecord[] {
  return records.filter((r) => k(r) === k(ref)).sort((a, b) => (a.recordedAt === b.recordedAt ? (a.id < b.id ? 1 : -1) : a.recordedAt < b.recordedAt ? 1 : -1))
}

/** How much a price moved, in basis points of the old price (positive = dearer). Null when there is nothing to compare. */
export function changeBp(oldPrice: number | null | undefined, newPrice: number): number | null {
  if (oldPrice === null || oldPrice === undefined || oldPrice <= 0) return null
  return Math.round(((newPrice - oldPrice) * 10000) / oldPrice)
}

/** Price of one BASE unit (so a carton of 24 and a single bottle can be compared). */
export const perBaseUnit = (price: Xaf, factor: number): Xaf => Math.round(price / factor)

export interface QuoteRow {
  supplierId: string
  unitId: string
  unitName: string
  price: Xaf
  perBase: Xaf
  recordedAt: string
}

/** For one product: every supplier's current quote, cheapest per base unit first. */
export function bestSuppliers(
  productId: string,
  quotes: Map<string, SupplierPriceRecord>,
  units: ReadonlyMap<string, { name: string; factor: number }>,
): { rows: QuoteRow[]; cheapestSupplierId: string | null; cheapestSavingBp: number | null } {
  const per = new Map<string, QuoteRow>() // one row per supplier: their cheapest unit
  for (const q of quotes.values()) {
    if (q.productId !== productId) continue
    const u = units.get(q.unitId)
    if (!u) continue
    const row: QuoteRow = { supplierId: q.supplierId, unitId: q.unitId, unitName: u.name, price: q.price, perBase: perBaseUnit(q.price, u.factor), recordedAt: q.recordedAt }
    const cur = per.get(q.supplierId)
    if (!cur || row.perBase < cur.perBase) per.set(q.supplierId, row)
  }
  const rows = [...per.values()].sort((a, b) => a.perBase - b.perBase || (a.supplierId < b.supplierId ? -1 : 1))
  return {
    rows,
    cheapestSupplierId: rows[0]?.supplierId ?? null,
    cheapestSavingBp: rows.length > 1 ? changeBp(rows[rows.length - 1].perBase, rows[0].perBase) : null,
  }
}

/* ------------------------------ what was really paid ------------------------------ */

export interface PaidRow { baseCost: Xaf; at: string }

/**
 * The cost per base unit of the most recent delivery of each product from each supplier. The cost of a delivery is the share of the
 * order cost it represents, so a part delivery is priced correctly.
 */
export function lastPaid(
  purchases: readonly { id: string; supplierId: string }[],
  receipts: readonly { id: string; purchaseId: string; receivedAt: string }[],
  lines: readonly { receiptId: string; productId: string; baseQuantity: number; totalCost: Xaf }[],
): Map<string, PaidRow> {
  const supplierOf = new Map(purchases.map((p) => [p.id, p.supplierId]))
  const receipt = new Map(receipts.map((r) => [r.id, r]))
  const out = new Map<string, PaidRow>()
  for (const l of lines) {
    const r = receipt.get(l.receiptId)
    const supplier = r ? supplierOf.get(r.purchaseId) : undefined
    if (!r || !supplier || l.baseQuantity <= 0) continue
    const key = `${supplier}|${l.productId}`
    const cur = out.get(key)
    if (!cur || r.receivedAt > cur.at) out.set(key, { baseCost: Math.round(l.totalCost / l.baseQuantity), at: r.receivedAt })
  }
  return out
}

export type CostWarning = 'above_quote' | 'above_last_paid' | null

/** Warn when a cost typed on an order is clearly dearer than the quote (over 5%) or than the last price paid (over 10%). */
export function costWarning(enteredPerBase: number, quotedPerBase: number | null, lastPaidPerBase: number | null): CostWarning {
  const over = (ref: number | null, bp: number) => ref !== null && ref > 0 && ((enteredPerBase - ref) * 10000) / ref > bp
  if (over(quotedPerBase, 500)) return 'above_quote'
  if (over(lastPaidPerBase, 1000)) return 'above_last_paid'
  return null
}

/** Suggested total cost for an order line from the current quote: price of one unit times the quantity in that unit. */
export function suggestedTotal(price: Xaf, quantity: number): Xaf {
  return Math.round(price * quantity)
}

export const STALE_QUOTE_DAYS = 90
export const isStale = (iso: string, now: Date): boolean => (now.getTime() - new Date(iso).getTime()) / 86_400_000 > STALE_QUOTE_DAYS
