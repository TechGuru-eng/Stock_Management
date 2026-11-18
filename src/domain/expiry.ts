/**
 * Expiry tracking (best-before dates). Pure rules.
 *
 * How it works without changing how stock is counted:
 *  - When goods with a date come in, a BATCH is recorded: how many units, expiring on which day.
 *  - Remaining stock per batch is DERIVED, never stored: everything that has gone out (sales, damage, write-offs, transfers) is taken
 *    from the oldest stock first (FEFO: first expiry, first out). Stock that came in without a date is assumed to be the oldest and goes
 *    first. So a batch's remaining quantity always agrees with the stock figure, on every device.
 *  - Writing off expired goods is an ordinary "expired" stock removal, which by this rule consumes the earliest-expiring units.
 * This is an approximation of what is really sold (a shopkeeper may sell the newest first); the figures are for warning, and a count corrects reality.
 */
export interface BatchRecord {
  id: string
  tenantId: string
  shopId: string
  productId: string
  /** The last day the goods are good, as `yyyy-mm-dd`. */
  expiry: string
  /** Base units that came in with this date. */
  quantity: number
  receivedAt: string
  recordedBy: string
}

export interface RemainingBatch {
  id: string | null
  /** null = stock without a date. */
  expiry: string | null
  quantity: number
}

/**
 * The batches still on the shelf for ONE product in ONE shop, oldest first. `onHand` is the stock figure; the batches say how much of
 * it carries which date. Stock above what the dated batches explain is "undated" (and assumed oldest).
 */
export function remainingBatches(onHand: number, batches: readonly Pick<BatchRecord, 'id' | 'expiry' | 'quantity' | 'receivedAt'>[]): RemainingBatch[] {
  const have = Math.max(onHand, 0)
  const sorted = [...batches].sort((a, b) => (a.expiry === b.expiry ? (a.receivedAt < b.receivedAt ? -1 : 1) : a.expiry < b.expiry ? -1 : 1))
  const dated = sorted.reduce((t, b) => t + b.quantity, 0)
  // newest dated stock is the last to be used up: keep from the END until `have` is explained, the rest of the shelf is undated
  let left = have
  const kept: RemainingBatch[] = []
  for (let i = sorted.length - 1; i >= 0 && left > 0; i--) {
    const take = Math.min(sorted[i].quantity, left)
    kept.unshift({ id: sorted[i].id, expiry: sorted[i].expiry, quantity: take })
    left -= take
  }
  const undated = Math.max(have - Math.min(have, dated), 0) // stock the dated batches do not account for
  return undated > 0 ? [{ id: null, expiry: null, quantity: undated }, ...kept] : kept
}

export type ExpiryStatus = 'expired' | 'soon' | 'ok' | 'undated'

export const daysUntil = (expiry: string, today: Date): number => {
  const [y, m, d] = expiry.split('-').map(Number)
  const end = Date.UTC(y, m - 1, d)
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((end - start) / 86_400_000)
}

export function statusOf(expiry: string | null, today: Date, warnDays: number): ExpiryStatus {
  if (!expiry) return 'undated'
  const d = daysUntil(expiry, today)
  return d < 0 ? 'expired' : d <= warnDays ? 'soon' : 'ok'
}

export interface ExpiryRow {
  productId: string
  name: string
  baseUnit: string
  batchId: string | null
  expiry: string
  daysLeft: number
  quantity: number
  /** Value at the product's average cost. */
  value: number
  status: 'expired' | 'soon'
}

export interface ProductExpiryInput {
  id: string
  name: string
  baseUnit: string
  trackExpiry: boolean
  active: boolean
  onHand: number
  /** Average cost of one base unit. */
  avgCost: number
}

/** Everything expired or expiring within `warnDays`, soonest first. Only products that track dates. */
export function expiryRows(
  products: readonly ProductExpiryInput[],
  batches: readonly BatchRecord[],
  today: Date,
  warnDays: number,
): ExpiryRow[] {
  const out: ExpiryRow[] = []
  for (const p of products) {
    if (!p.trackExpiry || !p.active) continue
    for (const b of remainingBatches(p.onHand, batches.filter((x) => x.productId === p.id))) {
      if (!b.expiry || b.quantity <= 0) continue
      const st = statusOf(b.expiry, today, warnDays)
      if (st !== 'expired' && st !== 'soon') continue
      out.push({ productId: p.id, name: p.name, baseUnit: p.baseUnit, batchId: b.id, expiry: b.expiry, daysLeft: daysUntil(b.expiry, today), quantity: b.quantity, value: Math.round(b.quantity * p.avgCost), status: st })
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name))
}

export interface ExpirySummary {
  expiredUnits: number
  expiredValue: number
  soonUnits: number
  soonValue: number
  products: number
}

export function summarizeExpiry(rows: readonly ExpiryRow[]): ExpirySummary {
  const sum = (st: ExpiryRow['status'], k: 'quantity' | 'value') => rows.filter((r) => r.status === st).reduce((t, r) => t + r[k], 0)
  return { expiredUnits: sum('expired', 'quantity'), expiredValue: sum('expired', 'value'), soonUnits: sum('soon', 'quantity'), soonValue: sum('soon', 'value'), products: new Set(rows.map((r) => r.productId)).size }
}

/** How many units of one product are expired right now (what a write-off would remove). */
export function expiredQuantity(onHand: number, batches: readonly BatchRecord[], today: Date): number {
  return remainingBatches(onHand, batches).reduce((t, b) => t + (b.expiry && daysUntil(b.expiry, today) < 0 ? b.quantity : 0), 0)
}

/** Units of a product that are still good (undated stock counts as good: nobody knows otherwise). */
export function goodQuantity(onHand: number, batches: readonly BatchRecord[], today: Date): number {
  return Math.max(onHand, 0) - expiredQuantity(onHand, batches, today)
}

/** A date typed or picked as `yyyy-mm-dd`, in a sensible range (not in the distant past, not decades ahead). */
export function validExpiry(text: string, today: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const [y, m, d] = text.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false
  const days = daysUntil(text, today)
  return days >= -366 && days <= 3650
}
