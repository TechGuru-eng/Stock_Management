import { db } from './db'
import { emptyCostState, issue, receive, type CostState } from '../domain/costing'

/**
 * The stock ledger (movements) is the source of truth. The cost state of a product
 * is a projection that can ALWAYS be rebuilt by replaying the movements in one
 * agreed order. Two devices holding the same movements therefore compute the same
 * stock and value, even when they sold offline in a different order.
 *
 * Order: oldest first; at the same instant stock coming IN is replayed before stock
 * going OUT; remaining ties are broken by id.
 */
export function replayOrder(
  a: { createdAt: string; quantity: number; id: string },
  b: { createdAt: string; quantity: number; id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  if (a.quantity > 0 !== b.quantity > 0) return a.quantity > 0 ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function replay(
  movements: readonly { createdAt: string; quantity: number; id: string; totalCost?: number; unitCost?: number }[],
): CostState {
  let state: CostState = emptyCostState
  for (const m of [...movements].sort(replayOrder)) {
    if (m.quantity > 0) {
      const cost = m.totalCost ?? Math.round((m.unitCost ?? state.lastUnitCost) * m.quantity)
      state = receive(state, m.quantity, cost)
    } else {
      state = issue(state, -m.quantity).state
    }
  }
  return state
}

export async function rebuildCost(shopId: string, productId: string): Promise<CostState> {
  const all = await db.movements.where('productId').equals(productId).toArray()
  const state = replay(all.filter((m) => m.shopId === shopId))
  await db.costs.put({ key: `${shopId}:${productId}`, shopId, productId, ...state })
  return state
}

export async function rebuildCosts(pairs: Iterable<{ shopId: string; productId: string }>): Promise<void> {
  const seen = new Set<string>()
  for (const p of pairs) {
    const k = `${p.shopId}:${p.productId}`
    if (seen.has(k)) continue
    seen.add(k)
    await rebuildCost(p.shopId, p.productId)
  }
}
