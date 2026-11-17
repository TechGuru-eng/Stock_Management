import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../data/db'
import { summarize, type Summary } from '../../domain/reports'

/** Figures for a period, always computed from the underlying records, never stored. */
export function useSummary(from: string, to: string, shopId: string): Summary | undefined {
  return useLiveQuery(
    async () =>
      summarize({
        sales: await db.sales.toArray(),
        lines: await db.saleLines.toArray(),
        txns: await db.transactions.toArray(),
        expenses: await db.expenses.toArray(),
        entries: await db.customerEntries.toArray(),
        supplierEntries: await db.supplierEntries.toArray(),
        returns: await db.saleReturns.toArray(),
        returnLines: await db.returnLines.toArray(),
        from, to, shopId,
      }),
    [from, to, shopId],
  )
}

/** Customer balances: positive = the customer owes; negative = credit in the customer's favour. */
export function useBalances() {
  return useLiveQuery(async () => {
    const customers = await db.customers.orderBy('name').toArray()
    const entries = await db.customerEntries.toArray()
    const sums = new Map<string, number>()
    for (const e of entries) sums.set(e.customerId, (sums.get(e.customerId) ?? 0) + e.amount)
    return customers.map((c) => ({ customer: c, balance: sums.get(c.id) ?? 0 }))
  }, [])
}
