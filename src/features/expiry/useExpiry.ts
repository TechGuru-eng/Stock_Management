import { useLiveQuery } from 'dexie-react-hooks'
import { loadExpiry, summarizeExpiry } from '../../data/batchesRepo'
import { useCtx } from '../../data/useCtx'
import { can } from '../../domain/permissions'
import type { ExpiryRow } from '../../domain/expiry'

export interface ExpiryState {
  rows: ExpiryRow[]
  warnDays: number
  summary: ReturnType<typeof summarizeExpiry>
  /** Units of each product that are expired right now. */
  expiredByProduct: Map<string, number>
}

/** Expired and soon-to-expire stock of the current shop, kept up to date. Only for people who look after stock. */
export function useExpiry(): ExpiryState | null {
  const ctx = useCtx()
  const data = useLiveQuery(async () => (ctx && can(ctx.role, 'stock.receive') ? loadExpiry(ctx) : null), [ctx?.shopId, ctx?.role])
  if (!data) return null
  const expiredByProduct = new Map<string, number>()
  for (const r of data.rows) if (r.status === 'expired') expiredByProduct.set(r.productId, (expiredByProduct.get(r.productId) ?? 0) + r.quantity)
  return { ...data, summary: summarizeExpiry(data.rows), expiredByProduct }
}
