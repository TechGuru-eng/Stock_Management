import type { SaleLineRecord, SaleRecord } from './pos'
import type { ReturnLineRecord, ReturnRecord } from './returns'
import { bestSuppliers, lastPaid, type SupplierPriceRecord, currentQuotes } from './supplierPrices'

/**
 * What to order. For one shop, from how fast each product really sells, what is on the shelf and what is already on order.
 * It SUGGESTS: nothing is ordered until a person reviews the list and creates the orders. Pure rules, no screens or databases.
 *
 * The idea, per product:
 *   speed        = base units sold per day over the last `windowDays` days (net of customer returns)
 *   target       = speed x coverDays (+ the minimum stock the shop wants to keep)
 *   to order     = target - on hand - already on order (rounded up to whole cartons when the product has a carton)
 */
export interface ReorderSettings {
  /** How many days of sales an order should cover. */
  coverDays: number
  /** How many past days sales are averaged over. */
  windowDays: number
  /** How many days a delivery takes: stock that will run out sooner than this is urgent. */
  leadDays: number
  roundToPack: boolean
}

export const DEFAULT_REORDER: ReorderSettings = { coverDays: 14, windowDays: 30, leadDays: 7, roundToPack: true }

/** Base units sold per day for each product in the shop, net of returns, over [from, to]. */
export function salesSpeed(input: {
  sales: readonly SaleRecord[]
  lines: readonly SaleLineRecord[]
  returns?: readonly ReturnRecord[]
  returnLines?: readonly ReturnLineRecord[]
  shopId: string
  from: string
  to: string
  windowDays: number
}): Map<string, number> {
  const inRange = (iso: string) => iso >= input.from && iso <= input.to
  const saleIds = new Set(input.sales.filter((s) => s.status === 'completed' && s.shopId === input.shopId && inRange(s.occurredAt)).map((s) => s.id))
  const sold = new Map<string, number>()
  for (const l of input.lines) if (saleIds.has(l.saleId)) sold.set(l.productId, (sold.get(l.productId) ?? 0) + l.baseQuantity)
  const retIds = new Set((input.returns ?? []).filter((r) => r.shopId === input.shopId && inRange(r.occurredAt)).map((r) => r.id))
  for (const l of input.returnLines ?? []) if (retIds.has(l.returnId)) sold.set(l.productId, (sold.get(l.productId) ?? 0) - l.baseQuantity)
  const out = new Map<string, number>()
  for (const [p, q] of sold) if (q > 0) out.set(p, q / Math.max(input.windowDays, 1))
  return out
}

/** Base units ordered for this shop and not yet delivered, per product. */
export function onOrder(
  shopId: string,
  purchases: readonly { id: string; shopId: string }[],
  lines: readonly { id: string; purchaseId: string; productId: string; baseQuantity: number }[],
  receiptLines: readonly { purchaseLineId: string; baseQuantity: number }[],
): Map<string, number> {
  const mine = new Set(purchases.filter((p) => p.shopId === shopId).map((p) => p.id))
  const received = new Map<string, number>()
  for (const r of receiptLines) received.set(r.purchaseLineId, (received.get(r.purchaseLineId) ?? 0) + r.baseQuantity)
  const out = new Map<string, number>()
  for (const l of lines) {
    if (!mine.has(l.purchaseId)) continue
    const open = l.baseQuantity - (received.get(l.id) ?? 0)
    if (open > 0) out.set(l.productId, (out.get(l.productId) ?? 0) + open)
  }
  return out
}

export type Urgency = 'out' | 'urgent' | 'soon' | 'low'

export interface ProductForReorder {
  id: string
  name: string
  minStock: number
  isService: boolean
  active: boolean
  /** Base units in the biggest pack (carton), 1 when there is none. */
  packFactor: number
  packName?: string
  baseUnit: string
}

export interface Suggestion {
  productId: string
  name: string
  baseUnit: string
  onHand: number
  onOrder: number
  /** Base units sold per day (0 when nothing sold lately). */
  speed: number
  /** How many days the stock on hand lasts at this speed (null when it is not selling). */
  daysLeft: number | null
  minStock: number
  urgency: Urgency
  /** Suggested quantity in base units. */
  qty: number
  /** The same quantity in whole packs, when the product has a pack and the rounding is on. */
  packs: number | null
  packName?: string
}

export function roundUpToPack(qty: number, pack: number): number {
  return pack > 1 ? Math.ceil(qty / pack) * pack : qty
}

export function suggestReorders(
  products: readonly ProductForReorder[],
  onHand: ReadonlyMap<string, number>,
  speed: ReadonlyMap<string, number>,
  incoming: ReadonlyMap<string, number>,
  s: ReorderSettings,
): Suggestion[] {
  const out: Suggestion[] = []
  for (const p of products) {
    if (p.isService || !p.active) continue
    const have = onHand.get(p.id) ?? 0
    const rate = speed.get(p.id) ?? 0
    const coming = incoming.get(p.id) ?? 0
    const target = Math.ceil(rate * s.coverDays) + p.minStock
    const need = target - have - coming
    if (need <= 0) continue
    // a product that does not sell and is not below its minimum does not need ordering just because the target says so
    const belowMin = p.minStock > 0 && have + coming <= p.minStock
    const daysLeft = rate > 0 ? Math.max(have, 0) / rate : null
    if (rate === 0 && !belowMin) continue
    const urgency: Urgency =
      have <= 0 && rate > 0 ? 'out'
      : daysLeft !== null && daysLeft < s.leadDays ? 'urgent'
      : daysLeft !== null && daysLeft < s.coverDays ? 'soon'
      : 'low'
    const qty = s.roundToPack ? roundUpToPack(need, p.packFactor) : need
    out.push({
      productId: p.id, name: p.name, baseUnit: p.baseUnit, onHand: have, onOrder: coming, speed: rate, daysLeft, minStock: p.minStock, urgency, qty,
      packs: s.roundToPack && p.packFactor > 1 ? qty / p.packFactor : null, packName: p.packFactor > 1 ? p.packName : undefined,
    })
  }
  const rank: Record<Urgency, number> = { out: 0, urgent: 1, soon: 2, low: 3 }
  return out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9) || a.name.localeCompare(b.name))
}

/* --------------------------- who to order from --------------------------- */

export interface Sourced extends Suggestion {
  supplierId: string | null
  /** Price of one base unit from that supplier (null when we have no price at all). */
  unitCost: number | null
  costSource: 'quote' | 'last_paid' | 'average' | null
  /** Estimated cost of the suggested quantity. */
  estimate: number | null
}

/**
 * Picks a supplier per product: the one with the cheapest current quote per base unit; otherwise the one we last bought it from at the
 * price we paid; otherwise none (priced from the shop's average cost, marked as an estimate).
 */
export function chooseSuppliers(
  suggestions: readonly Suggestion[],
  prices: readonly SupplierPriceRecord[],
  units: ReadonlyMap<string, { name: string; factor: number }>,
  paid: ReturnType<typeof lastPaid>,
  averageCost: ReadonlyMap<string, number>,
): Sourced[] {
  const quotes = currentQuotes(prices)
  return suggestions.map((s) => {
    const best = bestSuppliers(s.productId, quotes, units)
    let supplierId: string | null = null
    let unitCost: number | null = null
    let costSource: Sourced['costSource'] = null
    if (best.rows.length > 0) {
      supplierId = best.rows[0].supplierId; unitCost = best.rows[0].perBase; costSource = 'quote'
    } else {
      let latest: { supplierId: string; baseCost: number; at: string } | null = null
      for (const [k, v] of paid) {
        const [sup, prod] = k.split('|')
        if (prod === s.productId && (!latest || v.at > latest.at)) latest = { supplierId: sup, baseCost: v.baseCost, at: v.at }
      }
      if (latest) { supplierId = latest.supplierId; unitCost = latest.baseCost; costSource = 'last_paid' }
    }
    if (unitCost === null && (averageCost.get(s.productId) ?? 0) > 0) { unitCost = averageCost.get(s.productId)!; costSource = 'average' }
    return { ...s, supplierId, unitCost, costSource, estimate: unitCost === null ? null : Math.round(unitCost * s.qty) }
  })
}

/** The suggestions grouped by supplier (rows without a supplier together), suppliers with the most urgent rows first. */
export function groupBySupplier(rows: readonly Sourced[]): { supplierId: string | null; rows: Sourced[]; estimate: number }[] {
  const groups = new Map<string | null, Sourced[]>()
  for (const r of rows) groups.set(r.supplierId, [...(groups.get(r.supplierId) ?? []), r])
  const rank: Record<Urgency, number> = { out: 0, urgent: 1, soon: 2, low: 3 }
  return [...groups.entries()]
    .map(([supplierId, rs]) => ({ supplierId, rows: rs, estimate: rs.reduce((t, r) => t + (r.estimate ?? 0), 0) }))
    .sort((a, b) => {
      if ((a.supplierId === null) !== (b.supplierId === null)) return a.supplierId === null ? 1 : -1
      return Math.min(...a.rows.map((r) => rank[r.urgency])) - Math.min(...b.rows.map((r) => rank[r.urgency])) || b.estimate - a.estimate
    })
}

/** A readable order message (WhatsApp / SMS) to send to a supplier. */
export function orderMessage(
  lang: 'fr' | 'en',
  shopName: string,
  lines: readonly { name: string; qty: number; baseUnit: string; packs?: number | null; packName?: string }[],
): string {
  const head = lang === 'fr' ? `Bonjour, commande de ${shopName} :` : `Hello, order from ${shopName}:`
  const body = lines.map((l) => (l.packs && l.packName ? `- ${l.name} : ${l.packs} ${l.packName}` : `- ${l.name} : ${l.qty} ${l.baseUnit}`))
  const tail = lang === 'fr' ? 'Merci de confirmer la disponibilité et le prix.' : 'Please confirm availability and price.'
  return [head, ...body, tail].join('\n')
}
