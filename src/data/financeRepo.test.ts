import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
}

const { db } = await import('./db')
const repo = await import('./repo')
const fin = await import('./financeRepo')
const { summarize } = await import('../domain/reports')

const owner: import('./repo').Ctx = { tenantId: 't1', shopId: 's1', userId: 'owner', role: 'owner', oversellPolicy: 'allow_and_flag' }
const cashier: import('./repo').Ctx = { ...owner, userId: 'cashier', role: 'cashier' }

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

async function creditSale(amount: number, creditPart: number, ctx = owner) {
  const pid = await repo.addProduct(ctx.role === 'owner' ? ctx : owner, {
    name: `Item ${amount}`, baseUnit: 'piece', minStock: 0, taxRateBp: 0, isService: false,
    units: [{ name: 'piece', factor: 1, sellPrice: amount, isBase: true }], openingQty: 10, openingTotalCost: 10 * (amount / 2),
  })
  const unit = (await db.units.where('productId').equals(pid).first())!
  const customer = (await db.customers.toArray())[0] ?? (await repo.addCustomer(ctx, 'Mme Tchoua', '677000111', 500000))
  const payments: { method: 'cash' | 'credit'; amount: number }[] = []
  if (amount - creditPart > 0) payments.push({ method: 'cash', amount: amount - creditPart })
  payments.push({ method: 'credit', amount: creditPart })
  const r = await repo.checkout(ctx, {
    lines: [{ productId: pid, productName: 'x', unitId: unit.id, unitName: 'piece', factor: 1, unitPrice: amount, quantity: 1, lineDiscount: 0, taxRateBp: 0, isService: false }],
    payments, customerId: customer.id,
  })
  return { sale: r.sale, customer }
}

describe('customer debt repayment', () => {
  it('50,000 owed, 10,000 repaid: balance 40,000; the original sale is unchanged; one atomic group', async () => {
    const { sale, customer } = await creditSale(50000, 50000)
    const outboxBefore = await db.outbox.count()
    const r = await fin.repayDebt(owner, { customerId: customer.id, amount: 10000, method: 'cash' })

    expect(await repo.customerBalance(customer.id)).toBe(40000)
    expect((await db.sales.get(sale.id))!.outstanding).toBe(50000) // history untouched
    expect(await db.transactions.where('saleId').equals(sale.id).count()).toBe(0) // no cash was collected at sale time
    expect((await fin.openSalesForCustomer(customer.id))[0].outstanding).toBe(40000)

    const rows = (await db.outbox.toArray()).slice(outboxBefore)
    expect(rows.map((x) => x.table)).toEqual(['financial_transactions', 'payments', 'payment_allocations', 'customer_account_entries'])
    expect(new Set(rows.map((x) => x.groupId)).size).toBe(1)
    expect(r.transaction.verification).toBe('recorded')
  })

  it('repaying across two unpaid sales settles the oldest first and refuses to over-repay', async () => {
    await creditSale(8000, 8000)
    const second = await creditSale(9000, 9000)
    await fin.repayDebt(owner, { customerId: second.customer.id, amount: 12000, method: 'mtn_momo' })
    const open = await fin.openSalesForCustomer(second.customer.id)
    expect(open.map((o) => o.outstanding)).toEqual([5000]) // 8,000 fully paid, 9,000 down to 5,000
    await expect(fin.repayDebt(owner, { customerId: second.customer.id, amount: 5001, method: 'cash' })).rejects.toThrow('larger than')
    expect(await repo.customerBalance(second.customer.id)).toBe(5000)
  })

  it('a cashier may take a repayment but not record an expense', async () => {
    const { customer } = await creditSale(10000, 10000)
    await expect(fin.repayDebt(cashier, { customerId: customer.id, amount: 1000, method: 'cash' })).resolves.toBeTruthy()
    await expect(fin.recordExpense(cashier, { category: 'rent', amount: 100, method: 'cash' })).rejects.toThrow('permission')
  })
})

describe('expenses', () => {
  it('records the expense and a matching negative ledger entry together', async () => {
    await fin.recordExpense(owner, { category: 'transport', amount: 3500, method: 'cash', description: 'taxi to market' })
    expect(await db.expenses.count()).toBe(1)
    const t = (await db.transactions.toArray())[0]
    expect(t).toMatchObject({ txnType: 'expense', amount: -3500 })
  })
})

describe('cash sessions (test 6)', () => {
  it('opening 20,000 + cash sales 100,000 - expenses 15,000 = 105,000; counting 100,000 records a 5,000 shortage', async () => {
    const s = await fin.openCashSession(cashier, 20000)
    expect(await fin.currentSession(cashier)).toMatchObject({ id: s.id })
    await expect(fin.openCashSession(cashier, 0)).rejects.toThrow('already open')

    // 100,000 of cash sales by this cashier
    const pid = await repo.addProduct(owner, {
      name: 'Sac', baseUnit: 'piece', minStock: 0, taxRateBp: 0, isService: false,
      units: [{ name: 'piece', factor: 1, sellPrice: 100000, isBase: true }], openingQty: 5, openingTotalCost: 300000,
    })
    const unit = (await db.units.where('productId').equals(pid).first())!
    await repo.checkout(cashier, {
      lines: [{ productId: pid, productName: 'Sac', unitId: unit.id, unitName: 'piece', factor: 1, unitPrice: 100000, quantity: 1, lineDiscount: 0, taxRateBp: 0, isService: false }],
      payments: [{ method: 'cash', amount: 100000 }],
    })
    await fin.recordExpense(owner, { category: 'rent', amount: 15000, method: 'cash' }) // owner's, not the cashier's till
    // the cashier's own expense is recorded by the owner here; give the cashier the permission path via manager instead
    const manager: import('./repo').Ctx = { ...owner, userId: 'cashier', role: 'manager' }
    await fin.recordExpense(manager, { category: 'transport', amount: 15000, method: 'cash' })

    const r = await fin.closeCashSession(cashier, s.id, 100000)
    expect(r.reconciliation.expected).toBe(105000)
    expect(r.closure.difference).toBe(-5000)
    expect(r.reconciliation.status).toBe('shortage')
    expect(await db.cashClosures.count()).toBe(1)
    expect(await fin.currentSession(cashier)).toBeUndefined()
    await expect(fin.closeCashSession(cashier, s.id, 100000)).rejects.toThrow('already closed')
  })

  it('only the owner can move cash in or out of the till, and it needs a reason', async () => {
    await expect(fin.moveCash(cashier, { kind: 'cash_withdrawal', amount: 1000, reason: 'x' })).rejects.toThrow('permission')
    await expect(fin.moveCash(owner, { kind: 'cash_withdrawal', amount: 1000, reason: '' })).rejects.toThrow('reason')
    const t = await fin.moveCash(owner, { kind: 'cash_withdrawal', amount: 1000, reason: 'bank deposit' })
    expect(t.amount).toBe(-1000)
  })
})

describe('reports from local records', () => {
  it('match the transactions behind them after a real day of operations', async () => {
    const { customer } = await creditSale(30000, 15000)
    await fin.repayDebt(owner, { customerId: customer.id, amount: 10000, method: 'cash' })
    await fin.recordExpense(owner, { category: 'rent', amount: 5000, method: 'cash' })
    const s = summarize({
      sales: await db.sales.toArray(), lines: await db.saleLines.toArray(), txns: await db.transactions.toArray(),
      expenses: await db.expenses.toArray(), entries: await db.customerEntries.toArray(),
      from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z',
    })
    expect(s.revenue).toBe(30000)
    expect(s.collectedTotal).toBe(15000 + 10000)
    expect(s.receivables).toBe(5000)
    expect(s.cogs).toBe(15000) // cost was half the price
    expect(s.operatingProfit).toBe(30000 - 15000 - 5000)
  })
})
