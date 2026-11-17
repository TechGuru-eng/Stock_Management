/** Rules for working with several shops. Pure: no screens, no database. */

export interface ShopInfo {
  id: string
  name: string
  town?: string | null
}

/** The shop to open with: the one used last time if this person may still use it, otherwise the first. */
export function pickShop(shops: readonly ShopInfo[], savedId: string | null | undefined): string | null {
  if (shops.length === 0) return null
  return shops.find((s) => s.id === savedId)?.id ?? shops[0].id
}

/** Whether the plan lets the business add one more active shop (limit null = unlimited). */
export function canAddShop(limit: number | null, activeShops: number): boolean {
  return limit === null || activeShops < limit
}

export interface TransferLineInput {
  productId: string
  /** Whole base units. */
  qty: number
}

export type TransferProblem = 'same_shop' | 'no_lines' | 'bad_quantity' | 'duplicate_product' | 'not_enough_stock'

/**
 * Checks a transfer before anything is recorded. A transfer never takes stock that is not there (unlike a sale, which
 * may be allowed to oversell): moving goods you do not have would make the receiving shop's stock and value invented.
 */
export function checkTransfer(
  fromShopId: string,
  toShopId: string,
  lines: readonly TransferLineInput[],
  available: ReadonlyMap<string, number>,
): { ok: true } | { ok: false; problem: TransferProblem; productId?: string } {
  if (fromShopId === toShopId) return { ok: false, problem: 'same_shop' }
  if (lines.length === 0) return { ok: false, problem: 'no_lines' }
  const seen = new Set<string>()
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty <= 0) return { ok: false, problem: 'bad_quantity', productId: l.productId }
    if (seen.has(l.productId)) return { ok: false, problem: 'duplicate_product', productId: l.productId }
    seen.add(l.productId)
    if (l.qty > (available.get(l.productId) ?? 0)) return { ok: false, problem: 'not_enough_stock', productId: l.productId }
  }
  return { ok: true }
}
