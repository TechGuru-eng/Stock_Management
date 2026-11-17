import type { Xaf } from './money'
import type { ExpenseRecord } from './finance'
import type { ReturnLineRecord, ReturnRecord } from './returns'
import type { CustomerEntryRecord, SaleLineRecord, SaleRecord } from './pos'

/**
 * Detailed report tables. Pure functions over the same records the summary uses, so every table can be reconciled with the
 * headline numbers (the tests do exactly that). Nothing here is stored: it is always recomputed from the ledgers.
 */

/* ------------------------------- periods -------------------------------- */

export type PeriodKind = 'today' | 'last7' | 'thisMonth' | 'lastMonth'

/** Start and end (ISO) of a named period, in the device's local time. */
export function periodPreset(kind: PeriodKind, now: Date): { from: string; to: string } {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  if (kind === 'last7') start.setDate(start.getDate() - 6)
  if (kind === 'thisMonth') start.setDate(1)
  if (kind === 'lastMonth') {
    start.setMonth(start.getMonth() - 1, 1)
    end.setDate(0) // day 0 of this month = last day of the previous month
    end.setHours(23, 59, 59, 999)
  }
  return { from: start.toISOString(), to: end.toISOString() }
}

/** A `yyyy-mm-dd` date typed in a date field, as the start / end of that local day. */
export function dayStart(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString()
}
export function dayEnd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString()
}

const within = (iso: string, from: string, to: string) => iso >= from && iso <= to
const pad = (n: number) => String(n).padStart(2, '0')
export const localDate = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/* ------------------------------ by product ------------------------------ */

export interface ProductRow {
  productId: string
  name: string
  /** Base units sold, minus base units returned. */
  quantity: number
  /** Revenue excluding tax, after discounts and returns (adds up to the summary's revenue). */
  revenue: Xaf
  cogs: Xaf
  profit: Xaf
  /** Profit as a share of revenue, in basis points (null when there is no revenue). */
  marginBp: number | null
}

export interface ProductInput {
  sales: readonly SaleRecord[]
  lines: readonly SaleLineRecord[]
  returns?: readonly ReturnRecord[]
  returnLines?: readonly ReturnLineRecord[]
  from: string
  to: string
  shopId?: string
}

export function productPerformance(r: ProductInput): ProductRow[] {
  const sales = r.sales.filter((s) => s.status === 'completed' && within(s.occurredAt, r.from, r.to) && (!r.shopId || s.shopId === r.shopId))
  const ids = new Set(sales.map((s) => s.id))
  const acc = new Map<string, { name: string; quantity: number; revenue: number; cogs: number }>()
  const row = (id: string, name: string) => {
    let a = acc.get(id)
    if (!a) acc.set(id, (a = { name, quantity: 0, revenue: 0, cogs: 0 }))
    return a
  }
  for (const l of r.lines) {
    if (!ids.has(l.saleId)) continue
    const a = row(l.productId, l.productName)
    a.quantity += l.baseQuantity
    a.revenue += Math.round(l.unitPrice * l.quantity) - l.lineDiscount
    a.cogs += l.costOfGoods
  }
  const returns = (r.returns ?? []).filter((x) => within(x.occurredAt, r.from, r.to) && (!r.shopId || x.shopId === r.shopId))
  const rids = new Set(returns.map((x) => x.id))
  for (const l of r.returnLines ?? []) {
    if (!rids.has(l.returnId)) continue
    const a = row(l.productId, '—')
    a.quantity -= l.baseQuantity
    a.revenue -= l.netValue
    a.cogs -= l.costReversed
  }
  return [...acc.entries()]
    .map(([productId, a]) => ({
      productId, name: a.name, quantity: a.quantity, revenue: a.revenue, cogs: a.cogs, profit: a.revenue - a.cogs,
      marginBp: a.revenue > 0 ? Math.round(((a.revenue - a.cogs) * 10000) / a.revenue) : null,
    }))
    .sort((x, y) => y.revenue - x.revenue || x.name.localeCompare(y.name))
}

/* ------------------------------ stock value ----------------------------- */

export interface StockRow {
  productId: string
  name: string
  baseUnit: string
  quantity: number
  /** Average cost of one base unit (value / quantity), 0 when none in stock. */
  avgCost: Xaf
  value: Xaf
  minStock: number
  low: boolean
}

export function stockValuation(
  products: readonly { id: string; name: string; baseUnit: string; minStock: number; isService: boolean; active: boolean }[],
  costs: readonly { shopId: string; productId: string; quantity: number; value: number }[],
  shopId?: string,
): { rows: StockRow[]; totalValue: Xaf } {
  const rows: StockRow[] = []
  for (const p of products) {
    if (p.isService || !p.active) continue
    const mine = costs.filter((c) => c.productId === p.id && (!shopId || c.shopId === shopId))
    const quantity = mine.reduce((t, c) => t + c.quantity, 0)
    const value = mine.reduce((t, c) => t + c.value, 0)
    if (quantity === 0 && p.minStock === 0) continue
    rows.push({
      productId: p.id, name: p.name, baseUnit: p.baseUnit, quantity, value, minStock: p.minStock,
      avgCost: quantity > 0 ? Math.round(value / quantity) : 0, low: quantity <= p.minStock && p.minStock > 0,
    })
  }
  rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
  return { rows, totalValue: rows.reduce((t, r) => t + r.value, 0) }
}

/* ------------------------------ who owes us ----------------------------- */

export interface DebtorRow {
  customerId: string
  name: string
  phone?: string
  balance: Xaf
  /** The newest movement on the account (a purchase on credit or a repayment). */
  lastActivity: string | null
}

export function debtors(
  customers: readonly { id: string; name: string; phone?: string }[],
  entries: readonly CustomerEntryRecord[],
  asOf: string,
): { rows: DebtorRow[]; total: Xaf } {
  const sums = new Map<string, { balance: number; last: string | null }>()
  for (const e of entries) {
    if (e.occurredAt > asOf) continue
    const s = sums.get(e.customerId) ?? { balance: 0, last: null }
    s.balance += e.amount
    if (!s.last || e.occurredAt > s.last) s.last = e.occurredAt
    sums.set(e.customerId, s)
  }
  const rows = customers
    .map((c) => ({ customerId: c.id, name: c.name, phone: c.phone, balance: sums.get(c.id)?.balance ?? 0, lastActivity: sums.get(c.id)?.last ?? null }))
    .filter((r) => r.balance > 0)
    .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name))
  return { rows, total: rows.reduce((t, r) => t + r.balance, 0) }
}

/* ------------------------------- by day --------------------------------- */

export interface DayRow {
  date: string
  salesCount: number
  /** Revenue excluding tax, after discounts, minus returns that came back that day. */
  revenue: Xaf
  expenses: Xaf
}

export function dailyTable(r: {
  sales: readonly SaleRecord[]
  expenses: readonly ExpenseRecord[]
  returns?: readonly ReturnRecord[]
  from: string
  to: string
  shopId?: string
}): DayRow[] {
  const days = new Map<string, DayRow>()
  const get = (iso: string) => {
    const date = localDate(iso)
    let d = days.get(date)
    if (!d) days.set(date, (d = { date, salesCount: 0, revenue: 0, expenses: 0 }))
    return d
  }
  // every day in the range appears, even quiet ones
  for (let t = new Date(r.from); t <= new Date(r.to); t.setDate(t.getDate() + 1)) get(t.toISOString())
  get(r.to)
  for (const s of r.sales) {
    if (s.status !== 'completed' || !within(s.occurredAt, r.from, r.to) || (r.shopId && s.shopId !== r.shopId)) continue
    const d = get(s.occurredAt)
    d.salesCount++
    d.revenue += s.subtotal - s.discount
  }
  for (const x of r.returns ?? []) if (within(x.occurredAt, r.from, r.to) && (!r.shopId || x.shopId === r.shopId)) get(x.occurredAt).revenue -= x.netValue
  for (const e of r.expenses) if (within(e.occurredAt, r.from, r.to) && (!r.shopId || e.shopId === r.shopId)) get(e.occurredAt).expenses += e.amount
  return [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}
