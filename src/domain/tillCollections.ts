import type { Xaf } from './money'

/**
 * Mobile-money collected at the till: the customer approves a payment on their own phone, and the provider (not the cashier, not
 * the app) tells the server it arrived. Only then can a sale's mobile-money payment be "provider verified".
 *
 * Money goes straight to the business's own provider account. StockCM never holds it.
 */

export type CollectionProvider = 'mtn_momo' | 'orange_money'
export type CollectionStatus = 'initiated' | 'pending' | 'successful' | 'failed' | 'error'

export interface CollectionRecord {
  id: string
  tenantId: string
  shopId: string
  provider: CollectionProvider
  phone: string
  amount: Xaf
  status: CollectionStatus
  /** What the provider calls this payment (set by the server only). */
  providerReference?: string
  /** The sale that used it. Absent while the money is collected but not yet used. */
  saleId?: string
  createdAt: string
}

export const MIN_COLLECTION = 100
export const MAX_COLLECTION = 2_000_000
/** Money collected and never used by a sale is shown for this long, then it is the owner's matter (a refund by hand). */
export const UNUSED_DAYS = 30

export type RequestProblem = 'amount' | 'phone'

export function checkRequest(amount: number, phone: string): RequestProblem | null {
  if (!Number.isSafeInteger(amount) || amount < MIN_COLLECTION || amount > MAX_COLLECTION) return 'amount'
  if (!/^\+2376\d{8}$/.test(phone)) return 'phone'
  return null
}

/** A collection a sale may use right now: really paid, not used before, collected in this shop, not ancient. */
export function isUsable(c: CollectionRecord, ctx: { shopId: string; now: Date }): boolean {
  return (
    c.status === 'successful' &&
    !c.saleId &&
    c.shopId === ctx.shopId &&
    ctx.now.getTime() - new Date(c.createdAt).getTime() <= UNUSED_DAYS * 86_400_000
  )
}

/** Money waiting to be used: successful, unused, this shop, oldest first. */
export function unusedCollections(rows: readonly CollectionRecord[], ctx: { shopId: string; now: Date }): CollectionRecord[] {
  return rows.filter((c) => isUsable(c, ctx)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
}

/**
 * A collected amount is fixed (the customer approved exactly that), so it can only go into a sale that still needs at least that much
 * on that method. Returns why not, or null when it fits.
 */
export function fitsSale(c: CollectionRecord, remaining: Xaf): 'too_big' | null {
  return c.amount > remaining ? 'too_big' : null
}
