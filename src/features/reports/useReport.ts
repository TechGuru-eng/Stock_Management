import { useLiveQuery } from 'dexie-react-hooks'
import { loadRoster } from '../../auth/roster'
import { db } from '../../data/db'
import { dailyTable, debtors, employeePerformance, productPerformance, stockValuation } from '../../domain/reportTables'
import { summarize } from '../../domain/reports'

/** Everything the Reports screen shows for a period. Shop undefined = all shops. Always computed from the ledgers. */
export function useReport(from: string, to: string, shopId: string | undefined) {
  return useLiveQuery(async () => {
    const [sales, lines, txns, expenses, entries, supplierEntries, returns, returnLines, products, costs, customers, roster] = await Promise.all([
      db.sales.toArray(), db.saleLines.toArray(), db.transactions.toArray(), db.expenses.toArray(), db.customerEntries.toArray(),
      db.supplierEntries.toArray(), db.saleReturns.toArray(), db.returnLines.toArray(), db.products.toArray(), db.costs.toArray(), db.customers.toArray(),
      loadRoster(),
    ])
    const summary = summarize({ sales, lines, txns, expenses, entries, supplierEntries, returns, returnLines, from, to, shopId })
    const names = Object.values(roster).map((p) => ({ id: p.userId, name: p.name }))
    return {
      summary,
      products: productPerformance({ sales, lines, returns, returnLines, from, to, shopId }),
      employees: employeePerformance({ sales, returns, from, to, shopId, names }),
      daily: dailyTable({ sales, expenses, returns, from, to, shopId }),
      stock: stockValuation(products, costs, shopId),
      debtors: debtors(customers, entries, to),
      expenses: expenses
        .filter((e) => e.occurredAt >= from && e.occurredAt <= to && (!shopId || e.shopId === shopId))
        .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1)),
    }
  }, [from, to, shopId])
}
