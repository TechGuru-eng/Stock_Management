import { describe, expect, it } from 'vitest'
import { buildCashMovement, buildClosure, buildExpense, buildRepayment, openSalesOf, type CashSessionRecord } from './finance'
import { buildSale, type CartLine } from './pos'
import { receive, emptyCostState } from './costing'
import { dayRange, summarize } from './reports'
import { PaymentError } from './payments'

let n = 0
const newId = () => `id-${++n}`
const actor = { newId, tenantId: 't', shopId: 's', userId: 'u1', deviceId: 'd', nowIso: '2026-11-17T10:00:00.000Z' }

describe('customer debt repayment', () => {
  it('owes 50,000, repays 10,000: balance 40,000, the original sale is untouched', () => {
    const sales = [{ id: 'sale1', occurredAt: '2026-11-01T08:00:00Z', outstanding: 50000 }]
    const r = buildRepayment({
      ...actor, customerId: 'c1', method: 'cash', amount: 10000, reference: 'RP-1', openSales: openSalesOf(sales, []),
    })
    expect(r.transaction).toMatchObject({ txnType: 'debt_repayment', amount: 10000, verification: 'recorded' })
    expect(r.entry.amount).toBe(-10000)
    expect(r.allocations).toEqual([expect.objectContaining({ saleId: 'sale1', amount: 10000 })])
    expect(sales[0].outstanding).toBe(50000)
    // what is still open on that sale afterwards
    expect(openSalesOf(sales, r.allocations)[0].outstanding).toBe(40000)
  })

  it('settles several unpaid sales oldest first', () => {
    const sales = [
      { id: 'b', occurredAt: '2026-11-05T08:00:00Z', outstanding: 9000 },
      { id: 'a', occurredAt: '2026-11-01T08:00:00Z', outstanding: 8000 },
    ]
    const r = buildRepayment({ ...actor, customerId: 'c1', method: 'mtn_momo', amount: 12000, reference: 'RP-2', openSales: openSalesOf(sales, []) })
    expect(r.allocations.map((x) => [x.saleId, x.amount])).toEqual([['a', 8000], ['b', 4000]])
    expect(r.allocations.reduce((t, x) => t + x.amount, 0)).toBe(r.payment.amount)
  })

  it('refuses to repay more than is owed', () => {
    expect(() =>
      buildRepayment({ ...actor, customerId: 'c1', method: 'cash', amount: 9000, reference: 'RP-3', openSales: [{ saleId: 'a', createdAt: '1', outstanding: 8000 }] }),
    ).toThrow(PaymentError)
  })
})

describe('expenses and till movements', () => {
  it('an expense is one record and one negative ledger entry', () => {
    const r = buildExpense({ ...actor, category: 'rent', amount: 15000, method: 'cash', reference: 'EX-1' })
    expect(r.expense.amount).toBe(15000)
    expect(r.transaction.amount).toBe(-15000)
    expect(r.transaction.txnType).toBe('expense')
  })
  it('rejects a zero or unknown expense', () => {
    expect(() => buildExpense({ ...actor, category: 'rent', amount: 0, method: 'cash', reference: 'x' })).toThrow()
    expect(() => buildExpense({ ...actor, category: 'luxury' as never, amount: 5, method: 'cash', reference: 'x' })).toThrow(PaymentError)
  })
  it('a withdrawal needs a reason and reduces the till', () => {
    expect(() => buildCashMovement({ ...actor, kind: 'cash_withdrawal', amount: 5000, reason: ' ', reference: 'W' })).toThrow('reason')
    expect(buildCashMovement({ ...actor, kind: 'cash_withdrawal', amount: 5000, reason: 'bank', reference: 'W' }).amount).toBe(-5000)
    expect(buildCashMovement({ ...actor, kind: 'cash_deposit', amount: 5000, reason: 'float', reference: 'D' }).amount).toBe(5000)
  })
})

/** A whole day through the real builders, so every figure traces back to records. */
function day() {
  const line: CartLine = {
    productId: 'p', productName: 'Riz', unitId: 'u', unitName: 'sac', factor: 1, unitPrice: 10000, quantity: 3,
    lineDiscount: 0, taxRateBp: 0, isService: false,
  }
  // stock bought at 6,000 per sac
  const sale = buildSale({
    newId, tenantId: 't', shopId: 's', userId: 'u1', deviceId: 'd', role: 'cashier', saleNumber: 'A1-0001',
    nowIso: '2026-11-17T09:00:00.000Z', lines: [line],
    payments: [{ method: 'cash', amount: 10000 }, { method: 'mtn_momo', amount: 5000 }, { method: 'credit', amount: 15000 }],
    customer: { id: 'c1', creditLimit: 50000, balance: 0 },
    costStates: { p: receive(emptyCostState, 10, 60000) }, oversellPolicy: 'allow_and_flag',
  })
  const repay = buildRepayment({
    ...actor, nowIso: '2026-11-17T12:00:00.000Z', customerId: 'c1', method: 'cash', amount: 10000, reference: 'RP-1',
    openSales: openSalesOf([sale.sale], []),
  })
  const rent = buildExpense({ ...actor, nowIso: '2026-11-17T13:00:00.000Z', category: 'rent', amount: 5000, method: 'cash', reference: 'EX-1' })
  return { sale, repay, rent }
}

describe('cash session (test 6)', () => {
  it('expected cash comes from the ledger; a shortage is recorded permanently', () => {
    const { sale, repay, rent } = day()
    const session: CashSessionRecord = { id: 'cs', tenantId: 't', shopId: 's', openedBy: 'u1', openingCash: 20000, openedAt: '2026-11-17T07:00:00.000Z' }
    const txns = [...sale.transactions, repay.transaction, rent.transaction]
    const r = buildClosure({ ...actor, nowIso: '2026-11-17T18:00:00.000Z', session, txns, counted: 33000 })
    // 20,000 opening + 10,000 cash sale + 10,000 repayment - 5,000 rent = 35,000
    expect(r.totals).toMatchObject({ opening: 20000, cashSales: 10000, cashRepayments: 10000, cashExpenses: 5000 })
    expect(r.reconciliation.expected).toBe(35000)
    expect(r.closure.difference).toBe(-2000)
    expect(r.reconciliation.status).toBe('shortage')
  })

  it('mobile money and other cashiers do not count toward the till', () => {
    const { sale } = day()
    const session: CashSessionRecord = { id: 'cs', tenantId: 't', shopId: 's', openedBy: 'someone-else', openingCash: 0, openedAt: '2026-11-17T07:00:00.000Z' }
    const r = buildClosure({ ...actor, session, txns: sale.transactions, counted: 0 })
    expect(r.reconciliation.expected).toBe(0)
  })
})

describe('reports reconcile with the underlying records (test 19)', () => {
  it('separates revenue, collected cash, receivables, COGS and profit', () => {
    const { sale, repay, rent } = day()
    const range = dayRange(new Date('2026-11-17T12:00:00.000Z'))
    const s = summarize({
      sales: [sale.sale], lines: sale.lines, txns: [...sale.transactions, repay.transaction, rent.transaction],
      expenses: [rent.expense], entries: [sale.customerEntry!, repay.entry],
      from: '2026-11-17T00:00:00.000Z', to: '2026-11-17T23:59:59.999Z',
    })
    expect(range.from < range.to).toBe(true)
    expect(s.salesCount).toBe(1)
    expect(s.revenue).toBe(30000) // sold
    expect(s.collectedFromSales).toEqual({ cash: 10000, mtn_momo: 5000, orange_money: 0 })
    expect(s.debtRepayments).toBe(10000)
    expect(s.collectedTotal).toBe(25000) // received, not the same as revenue
    expect(s.creditGranted).toBe(15000)
    expect(s.receivables).toBe(5000) // 15,000 owed - 10,000 repaid
    expect(s.cogs).toBe(18000) // 3 sacs x 6,000
    expect(s.grossProfit).toBe(12000)
    expect(s.expenses).toBe(5000)
    expect(s.operatingProfit).toBe(7000)
  })

  it('every figure equals the sum of the records behind it', () => {
    const { sale, repay, rent } = day()
    const txns = [...sale.transactions, repay.transaction, rent.transaction]
    const s = summarize({
      sales: [sale.sale], lines: sale.lines, txns, expenses: [rent.expense], entries: [sale.customerEntry!, repay.entry],
      from: '2026-11-17T00:00:00.000Z', to: '2026-11-17T23:59:59.999Z',
    })
    const moneyIn = txns.filter((t) => t.amount > 0).reduce((t, x) => t + x.amount, 0)
    expect(s.collectedTotal).toBe(moneyIn)
    // an expense is counted once: in expenses, never again in collected money
    expect(txns.filter((t) => t.txnType === 'expense').reduce((t, x) => t - x.amount, 0)).toBe(s.expenses)
    expect(sale.sale.total).toBe(s.revenue + s.tax)
  })

  it('excludes records outside the period', () => {
    const { sale } = day()
    const s = summarize({
      sales: [sale.sale], lines: sale.lines, txns: sale.transactions, expenses: [], entries: [],
      from: '2026-11-18T00:00:00.000Z', to: '2026-11-18T23:59:59.999Z',
    })
    expect(s.salesCount).toBe(0)
    expect(s.revenue).toBe(0)
    expect(s.cogs).toBe(0)
  })
})
