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
const ret = await import('./returnsRepo')
const { summarize } = await import('../domain/reports')
const { saleReturnStatus } = await import('../domain/returns')

const owner: import('./repo').Ctx = { tenantId: 't1', shopId: 's1', userId: 'owner', role: 'owner', oversellPolicy: 'allow_and_flag' }
const manager: import('./repo').Ctx = { ...owner, userId: 'mgr', role: 'manager' }
const cashier: import('./repo').Ctx = { ...owner, userId: 'cash', role: 'cashier' }

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

/** 10 sacs bought at 6,000 each; sells 3 at 10,000. */
async function makeSale(payments: { method: 'cash' | 'mtn_momo' | 'credit'; amount: number }[], withCustomer = true) {
  const pid = await repo.addProduct(owner, {
    name: 'Riz', baseUnit: 'sac', minStock: 0, taxRateBp: 0, isService: false,
    units: [{ name: 'sac', factor: 1, sellPrice: 10000, isBase: true }], openingQty: 10, openingTotalCost: 60000,
  })
  const unit = (await db.units.where('productId').equals(pid).first())!
  const customer = withCustomer ? await repo.addCustomer(owner, 'Mme Tchoua', '677000111', 100000) : undefined
  const r = await repo.checkout(cashier, {
    lines: [{ productId: pid, productName: 'Riz', unitId: unit.id, unitName: 'sac', factor: 1, unitPrice: 10000, quantity: 3, lineDiscount: 0, taxRateBp: 0, isService: false }],
    payments, customerId: customer?.id,
  })
  return { pid, sale: r.sale, line: r.lines[0], customer }
}
const stock = async (pid: string) => (await db.costs.get(`s1:${pid}`))!.quantity

describe('a manager processes a return (tests 7, 8)', () => {
  it('after a partial repayment: debt written off first, the rest refunded in money, stock back, balances right', async () => {
    const { pid, sale, line, customer } = await makeSale([{ method: 'cash', amount: 10000 }, { method: 'mtn_momo', amount: 5000 }, { method: 'credit', amount: 15000 }])
    await fin.repayDebt(owner, { customerId: customer!.id, amount: 10000, method: 'cash' }) // 5,000 still owed
    expect(await stock(pid)).toBe(7)

    const r = await ret.processReturn(manager, sale.id, {
      kind: 'return', reason: 'customer returned all', refundMethod: 'cash',
      lines: [{ saleLineId: line.id, quantity: 3, restock: true }],
    })
    expect(r.ret).toMatchObject({ totalValue: 30000, debtReduced: 5000, refundedAmount: 25000 })
    expect(await stock(pid)).toBe(10) // all three back
    expect(await repo.customerBalance(customer!.id)).toBe(0) // owes nothing, and is owed nothing
    expect((await db.costs.get(`s1:${pid}`))!.value).toBe(60000) // stock value restored to cost
    expect((await db.sales.get(sale.id))!.total).toBe(30000) // the sale itself is unchanged
    const refund = (await db.transactions.toArray()).find((t) => t.txnType === 'refund')!
    expect(refund).toMatchObject({ amount: -25000, method: 'cash', returnId: r.ret.id, verification: 'recorded' })
    expect(saleReturnStatus(sale, await db.saleReturns.toArray())).toBe('returned')
  })

  it('reports show revenue and cost of goods netted, and refunds as money out', async () => {
    const { sale, line, customer } = await makeSale([{ method: 'cash', amount: 10000 }, { method: 'mtn_momo', amount: 5000 }, { method: 'credit', amount: 15000 }])
    await fin.repayDebt(owner, { customerId: customer!.id, amount: 10000, method: 'cash' })
    const read = async () => summarize({
      sales: await db.sales.toArray(), lines: await db.saleLines.toArray(), txns: await db.transactions.toArray(),
      expenses: [], entries: await db.customerEntries.toArray(), returns: await db.saleReturns.toArray(), returnLines: await db.returnLines.toArray(),
      from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z',
    })
    const before = await read()
    expect(before).toMatchObject({ revenue: 30000, cogs: 18000, collectedTotal: 25000, receivables: 5000, refundsPaid: 0 })

    await ret.processReturn(owner, sale.id, { kind: 'return', reason: 'x', refundMethod: 'cash', lines: [{ saleLineId: line.id, quantity: 3, restock: true }] })
    const after = await read()
    expect(after).toMatchObject({ revenue: 0, returnedRevenue: 30000, cogs: 0, grossProfit: 0, refundsPaid: 25000, collectedTotal: 0, receivables: 0 })
  })

  it('goods that are damaged are refunded but not put back, so their cost stays', async () => {
    const { pid, sale, line } = await makeSale([{ method: 'cash', amount: 30000 }], false)
    await ret.processReturn(manager, sale.id, { kind: 'return', reason: 'arrived broken', refundMethod: 'cash', lines: [{ saleLineId: line.id, quantity: 1, restock: false }] })
    expect(await stock(pid)).toBe(7) // unchanged: nothing went back
    expect(await db.movements.filter((m) => m.type === 'return_in').count()).toBe(0)
  })

  it('refuses a second return of what was already returned, and a refund beyond what was paid', async () => {
    const { sale, line } = await makeSale([{ method: 'cash', amount: 30000 }], false)
    const all = { saleLineId: line.id, quantity: 3, restock: true }
    await ret.processReturn(manager, sale.id, { kind: 'return', reason: 'x', refundMethod: 'cash', lines: [all] })
    await expect(ret.processReturn(manager, sale.id, { kind: 'return', reason: 'x', refundMethod: 'cash', lines: [{ ...all, quantity: 1 }] })).rejects.toThrow('more than was sold')
  })

  it('cancelling a sale reverses stock, money and debt together as one atomic group', async () => {
    const { pid, sale, customer } = await makeSale([{ method: 'cash', amount: 5000 }, { method: 'credit', amount: 25000 }])
    const before = await db.outbox.count()
    const r = await ret.cancelSale(owner, sale.id, 'wrong customer', 'cash')
    expect(r.ret).toMatchObject({ kind: 'cancellation', totalValue: 30000, debtReduced: 25000, refundedAmount: 5000 })
    expect(await stock(pid)).toBe(10)
    expect(await repo.customerBalance(customer!.id)).toBe(0)
    expect(saleReturnStatus(sale, await db.saleReturns.toArray())).toBe('cancelled')

    const rows = (await db.outbox.toArray()).slice(before)
    expect(rows.map((x) => x.table)).toEqual(['sale_returns', 'sale_return_lines', 'stock_movements', 'financial_transactions', 'customer_account_entries'])
    expect(new Set(rows.map((x) => x.groupId)).size).toBe(1)
    await expect(ret.cancelSale(owner, sale.id, 'again', 'cash')).rejects.toThrow()
  })
})

describe('approval flow for cashiers', () => {
  it('a cashier can only request; the manager approves and the return then happens', async () => {
    const { pid, sale, line } = await makeSale([{ method: 'cash', amount: 30000 }], false)
    const request = { kind: 'return' as const, reason: 'faulty', refundMethod: 'cash' as const, lines: [{ saleLineId: line.id, quantity: 1, restock: true }] }
    await expect(ret.processReturn(cashier, sale.id, request)).rejects.toThrow('only a manager')
    expect(await db.saleReturns.count()).toBe(0)

    const req = await ret.requestReturn(cashier, sale.id, request)
    expect(await stock(pid)).toBe(7) // nothing moved yet
    expect(await ret.pendingApprovals()).toHaveLength(1)

    await expect(ret.approveRequest(cashier, req.id)).rejects.toThrow('only a manager')
    const done = await ret.approveRequest(manager, req.id)
    expect(done.ret.approvedBy).toBe('mgr')
    expect(await stock(pid)).toBe(8)
    expect(await ret.pendingApprovals()).toHaveLength(0)
    expect((await db.approvalDecisions.toArray())[0]).toMatchObject({ decision: 'approved', returnId: done.ret.id })
    await expect(ret.approveRequest(manager, req.id)).rejects.toThrow('already decided')
  })

  it('a rejection needs a reason, changes nothing, and is final', async () => {
    const { pid, sale, line } = await makeSale([{ method: 'cash', amount: 30000 }], false)
    const req = await ret.requestReturn(cashier, sale.id, { kind: 'return', reason: 'no receipt', refundMethod: 'cash', lines: [{ saleLineId: line.id, quantity: 1, restock: true }] })
    await expect(ret.rejectRequest(manager, req.id, ' ')).rejects.toThrow('why')
    await ret.rejectRequest(manager, req.id, 'no proof of purchase')
    expect(await stock(pid)).toBe(7)
    expect(await db.saleReturns.count()).toBe(0)
    await expect(ret.approveRequest(manager, req.id)).rejects.toThrow('already decided')
  })

  it('a request that could never be approved is refused up front', async () => {
    const { sale, line } = await makeSale([{ method: 'cash', amount: 30000 }], false)
    await expect(ret.requestReturn(cashier, sale.id, { kind: 'return', reason: 'x', refundMethod: 'cash', lines: [{ saleLineId: line.id, quantity: 9, restock: true }] })).rejects.toThrow('more than was sold')
    expect(await db.approvalRequests.count()).toBe(0)
  })
})
