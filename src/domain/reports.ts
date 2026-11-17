import { sumXaf, type Xaf } from './money'
import type { ExpenseRecord } from './finance'
import type { CustomerEntryRecord, FinancialTxnRecord, SaleLineRecord, SaleRecord } from './pos'

/**
 * The words matter. These are DIFFERENT numbers and must never be mixed up:
 *   revenue      what was sold in the period, excluding tax (subtotal - discounts)
 *   collected    money actually received in the period (sales paid now + debt repayments)
 *   receivables  what customers still owe at the end of the period
 *   COGS         weighted-average cost of the goods sold
 *   gross profit revenue - COGS
 *   operating profit = gross profit - operating expenses
 * Operating profit is an operating measure, NOT accounting net profit.
 */
export interface ReportInput {
  sales: readonly SaleRecord[]
  lines: readonly SaleLineRecord[]
  txns: readonly FinancialTxnRecord[]
  expenses: readonly ExpenseRecord[]
  /** All customer-account entries up to now (balances are cumulative, not per period). */
  entries: readonly CustomerEntryRecord[]
  /** Supplier-account entries up to now: their sum is what we owe suppliers. */
  supplierEntries?: readonly { amount: Xaf; occurredAt: string }[]
  /** Inclusive ISO timestamps. */
  from: string
  to: string
  shopId?: string
}

export interface Summary {
  salesCount: number
  revenue: Xaf
  tax: Xaf
  discounts: Xaf
  creditGranted: Xaf
  collectedFromSales: Record<'cash' | 'mtn_momo' | 'orange_money', Xaf>
  debtRepayments: Xaf
  collectedTotal: Xaf
  receivables: Xaf
  /** What we owe suppliers at the end of the period. */
  supplierPayables: Xaf
  cogs: Xaf
  grossProfit: Xaf
  expenses: Xaf
  expensesByCategory: Record<string, Xaf>
  operatingProfit: Xaf
}

const within = (iso: string, from: string, to: string) => iso >= from && iso <= to

export function summarize(r: ReportInput): Summary {
  const sales = r.sales.filter((s) => s.status === 'completed' && within(s.occurredAt, r.from, r.to) && (!r.shopId || s.shopId === r.shopId))
  const saleIds = new Set(sales.map((s) => s.id))
  const lines = r.lines.filter((l) => saleIds.has(l.saleId))
  const txns = r.txns.filter((t) => within(t.occurredAt, r.from, r.to) && (!r.shopId || t.shopId === r.shopId))
  const expenses = r.expenses.filter((e) => within(e.occurredAt, r.from, r.to) && (!r.shopId || e.shopId === r.shopId))

  const revenue = sumXaf(sales.map((s) => s.subtotal - s.discount))
  const cogs = sumXaf(lines.map((l) => l.costOfGoods))

  const collectedFromSales = { cash: 0, mtn_momo: 0, orange_money: 0 }
  for (const t of txns) if (t.txnType === 'sale_collection') collectedFromSales[t.method] += t.amount
  const debtRepayments = sumXaf(txns.filter((t) => t.txnType === 'debt_repayment').map((t) => t.amount))

  const expensesByCategory: Record<string, Xaf> = {}
  for (const e of expenses) expensesByCategory[e.category] = (expensesByCategory[e.category] ?? 0) + e.amount
  const expenseTotal = sumXaf(expenses.map((e) => e.amount))
  const grossProfit = revenue - cogs

  return {
    salesCount: sales.length,
    revenue,
    tax: sumXaf(sales.map((s) => s.tax)),
    discounts: sumXaf(sales.map((s) => s.discount)),
    creditGranted: sumXaf(sales.map((s) => s.outstanding)),
    collectedFromSales,
    debtRepayments,
    collectedTotal: collectedFromSales.cash + collectedFromSales.mtn_momo + collectedFromSales.orange_money + debtRepayments,
    receivables: sumXaf(r.entries.filter((e) => e.occurredAt <= r.to).map((e) => e.amount)),
    supplierPayables: sumXaf((r.supplierEntries ?? []).filter((e) => e.occurredAt <= r.to).map((e) => e.amount)),
    cogs,
    grossProfit,
    expenses: expenseTotal,
    expensesByCategory,
    operatingProfit: grossProfit - expenseTotal,
  }
}

/** Start and end (ISO, UTC) of the calendar day containing `now`, in the device's local time. */
export function dayRange(now: Date): { from: string; to: string } {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  return { from: start.toISOString(), to: end.toISOString() }
}
