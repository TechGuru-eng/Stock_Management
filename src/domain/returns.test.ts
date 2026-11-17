import { describe, expect, it } from 'vitest'
import {
  buildApprovalRequest, buildDecision, buildReturn, fullReturn, pendingRequests, returnableQuantities, saleReturnStatus,
  type ReturnLineRecord,
} from './returns'
import { buildSale, type CartLine } from './pos'
import { emptyCostState, receive } from './costing'

let n = 0
const newId = () => `id-${++n}`
const actor = { newId, tenantId: 't', shopId: 's', userId: 'mgr', deviceId: 'd', nowIso: '2026-11-17T15:00:00.000Z' }

/** A real 30,000 sale built by the real checkout: 3 sacs at 10,000, cost 6,000 each. */
function sale(opts: { payments: { method: 'cash' | 'mtn_momo' | 'credit'; amount: number }[]; customer?: boolean }) {
  const line: CartLine = {
    productId: 'rice', productName: 'Riz', unitId: 'u', unitName: 'sac', factor: 1, unitPrice: 10000, quantity: 3,
    lineDiscount: 0, taxRateBp: 0, isService: false,
  }
  return buildSale({
    newId, tenantId: 't', shopId: 's', userId: 'c1', deviceId: 'd', role: 'cashier', saleNumber: 'A1-0001',
    nowIso: '2026-11-17T09:00:00.000Z', lines: [line], payments: opts.payments,
    customer: opts.customer ? { id: 'cust', creditLimit: 100000, balance: 0 } : undefined,
    costStates: { rice: receive(emptyCostState, 10, 60000) }, oversellPolicy: 'allow_and_flag',
  })
}

const base = (s: ReturnType<typeof sale>) => ({ ...actor, sale: s.sale, saleLines: s.lines, priorLines: [] as ReturnLineRecord[], reference: 'RF-1' })

describe('returning goods from a sale that was paid in full', () => {
  it('puts the goods back, reverses their cost, and refunds the money', () => {
    const s = sale({ payments: [{ method: 'cash', amount: 30000 }] })
    const r = buildReturn({
      ...base(s), openOnSale: 0, refundableMoney: 30000,
      request: { kind: 'return', reason: 'customer changed mind', refundMethod: 'cash', lines: [{ saleLineId: s.lines[0].id, quantity: 1, restock: true }] },
    })
    expect(r.ret).toMatchObject({ totalValue: 10000, netValue: 10000, refundedAmount: 10000, debtReduced: 0, refundMethod: 'cash' })
    expect(r.transaction).toMatchObject({ txnType: 'refund', amount: -10000, method: 'cash', verification: 'recorded' })
    expect(r.movements).toHaveLength(1)
    expect(r.movements[0]).toMatchObject({ type: 'return_in', quantity: 1, totalCost: 6000 })
    expect(r.lines[0].costReversed).toBe(6000)
    // the sale itself was not touched
    expect(s.sale.total).toBe(30000)
  })
})

describe('returning goods bought on credit (test 7)', () => {
  it('writes off the debt first and only refunds money for the rest', () => {
    // 10,000 cash + 5,000 MTN + 15,000 on credit
    const s = sale({ payments: [{ method: 'cash', amount: 10000 }, { method: 'mtn_momo', amount: 5000 }, { method: 'credit', amount: 15000 }], customer: true })
    const r = buildReturn({
      ...base(s), openOnSale: 15000, refundableMoney: 15000,
      request: { kind: 'return', reason: 'wrong goods', refundMethod: 'cash', lines: [{ saleLineId: s.lines[0].id, quantity: 3, restock: true }] },
    })
    expect(r.ret.totalValue).toBe(30000)
    expect(r.ret.debtReduced).toBe(15000)
    expect(r.ret.refundedAmount).toBe(15000)
    expect(r.entry).toMatchObject({ kind: 'reversal', amount: -15000, returnId: r.ret.id })
    expect(r.transaction!.amount).toBe(-15000)
  })

  it('after the customer repaid 10,000, only 5,000 is still owed, and 25,000 comes back as money', () => {
    const s = sale({ payments: [{ method: 'cash', amount: 10000 }, { method: 'mtn_momo', amount: 5000 }, { method: 'credit', amount: 15000 }], customer: true })
    const r = buildReturn({
      ...base(s), openOnSale: 5000, refundableMoney: 25000, // 15,000 at the till + 10,000 repaid later
      request: { kind: 'return', reason: 'faulty', refundMethod: 'mtn_momo', lines: [{ saleLineId: s.lines[0].id, quantity: 3, restock: true }] },
    })
    expect(r.ret.debtReduced).toBe(5000)
    expect(r.ret.refundedAmount).toBe(25000)
  })

  it('never refunds more than the customer actually paid', () => {
    const s = sale({ payments: [{ method: 'cash', amount: 10000 }, { method: 'credit', amount: 20000 }], customer: true })
    expect(() => buildReturn({
      ...base(s), openOnSale: 0, refundableMoney: 10000, // the debt was already repaid by someone else's rules; only 10,000 ever paid
      request: { kind: 'return', reason: 'x', refundMethod: 'cash', lines: [{ saleLineId: s.lines[0].id, quantity: 3, restock: true }] },
    })).toThrow('more than the customer paid')
  })

  it('a pure credit return needs no refund method and moves no money', () => {
    const s = sale({ payments: [{ method: 'credit', amount: 30000 }], customer: true })
    const r = buildReturn({
      ...base(s), openOnSale: 30000, refundableMoney: 0,
      request: { kind: 'return', reason: 'returned unopened', lines: [{ saleLineId: s.lines[0].id, quantity: 2, restock: true }] },
    })
    expect(r.transaction).toBeUndefined()
    expect(r.ret).toMatchObject({ debtReduced: 20000, refundedAmount: 0 })
  })
})

describe('partial returns add up exactly', () => {
  it('returning 1, then 1, then 1 of 3 items never loses or invents a franc', () => {
    const line: CartLine = { productId: 'p', productName: 'P', unitId: 'u', unitName: 'pc', factor: 1, unitPrice: 333, quantity: 3, lineDiscount: 0, taxRateBp: 0, isService: false }
    const s = buildSale({
      newId, tenantId: 't', shopId: 's', userId: 'c1', deviceId: 'd', role: 'cashier', saleNumber: 'A1-0002', nowIso: '2026-11-17T09:00:00.000Z',
      lines: [{ ...line, lineDiscount: 0 }], payments: [{ method: 'cash', amount: 999 }],
      costStates: { p: receive(emptyCostState, 3, 1000) }, oversellPolicy: 'allow_and_flag',
    })
    let prior: ReturnLineRecord[] = []
    const values: number[] = []
    const costs: number[] = []
    for (let i = 0; i < 3; i++) {
      const r = buildReturn({
        ...actor, sale: s.sale, saleLines: s.lines, priorLines: prior, openOnSale: 0, refundableMoney: 999, reference: `R${i}`,
        request: { kind: 'return', reason: 'x', refundMethod: 'cash', lines: [{ saleLineId: s.lines[0].id, quantity: 1, restock: true }] },
      })
      prior = [...prior, ...r.lines]
      values.push(r.ret.totalValue)
      costs.push(r.lines[0].costReversed)
    }
    expect(values.reduce((a, b) => a + b, 0)).toBe(999)
    expect(costs.reduce((a, b) => a + b, 0)).toBe(s.lines[0].costOfGoods)
    expect(returnableQuantities(s.lines, prior).get(s.lines[0].id)).toBe(0)
    expect(() => buildReturn({
      ...actor, sale: s.sale, saleLines: s.lines, priorLines: prior, openOnSale: 0, refundableMoney: 0, reference: 'R9',
      request: { kind: 'return', reason: 'x', refundMethod: 'cash', lines: [{ saleLineId: s.lines[0].id, quantity: 1, restock: true }] },
    })).toThrow('more than was sold')
  })
})

describe('damaged goods and validation', () => {
  it('goods that cannot be resold do not go back into stock and their cost is not reversed', () => {
    const s = sale({ payments: [{ method: 'cash', amount: 30000 }] })
    const r = buildReturn({
      ...base(s), openOnSale: 0, refundableMoney: 30000,
      request: { kind: 'return', reason: 'arrived broken', refundMethod: 'cash', lines: [{ saleLineId: s.lines[0].id, quantity: 1, restock: false }] },
    })
    expect(r.movements).toHaveLength(0)
    expect(r.lines[0].costReversed).toBe(0)
    expect(r.ret.refundedAmount).toBe(10000)
  })
  it('needs a reason, a refund method when money moves, and a real sale line', () => {
    const s = sale({ payments: [{ method: 'cash', amount: 30000 }] })
    const ok = { saleLineId: s.lines[0].id, quantity: 1, restock: true }
    expect(() => buildReturn({ ...base(s), openOnSale: 0, refundableMoney: 30000, request: { kind: 'return', reason: ' ', refundMethod: 'cash', lines: [ok] } })).toThrow('reason')
    expect(() => buildReturn({ ...base(s), openOnSale: 0, refundableMoney: 30000, request: { kind: 'return', reason: 'x', lines: [ok] } })).toThrow('how the money')
    expect(() => buildReturn({ ...base(s), openOnSale: 0, refundableMoney: 30000, request: { kind: 'return', reason: 'x', refundMethod: 'cash', lines: [{ ...ok, saleLineId: 'nope' }] } })).toThrow('not on this sale')
  })
})

describe('cancelling a sale (test 8)', () => {
  it('must return everything, and the sale then reads as cancelled', () => {
    const s = sale({ payments: [{ method: 'cash', amount: 30000 }] })
    const partial = { saleLineId: s.lines[0].id, quantity: 2, restock: true }
    expect(() => buildReturn({ ...base(s), openOnSale: 0, refundableMoney: 30000, request: { kind: 'cancellation', reason: 'wrong customer', refundMethod: 'cash', lines: [partial] } })).toThrow('everything')

    const r = buildReturn({
      ...base(s), openOnSale: 0, refundableMoney: 30000,
      request: { kind: 'cancellation', reason: 'wrong customer', refundMethod: 'cash', lines: fullReturn(s.lines, []) },
    })
    expect(r.ret.totalValue).toBe(30000)
    expect(r.movements[0].quantity).toBe(3)
    expect(saleReturnStatus(s.sale, [r.ret])).toBe('cancelled')
  })
  it('status follows the returns', () => {
    const s = sale({ payments: [{ method: 'cash', amount: 30000 }] })
    expect(saleReturnStatus(s.sale, [])).toBe('completed')
    const one = buildReturn({ ...base(s), openOnSale: 0, refundableMoney: 30000, request: { kind: 'return', reason: 'x', refundMethod: 'cash', lines: [{ saleLineId: s.lines[0].id, quantity: 1, restock: true }] } })
    expect(saleReturnStatus(s.sale, [one.ret])).toBe('partially_returned')
    const all = buildReturn({ ...base(s), priorLines: one.lines, openOnSale: 0, refundableMoney: 20000, request: { kind: 'return', reason: 'x', refundMethod: 'cash', lines: fullReturn(s.lines, one.lines) } })
    expect(saleReturnStatus(s.sale, [one.ret, all.ret])).toBe('returned')
  })
  it('tax is returned with the goods and the revenue part is tracked separately', () => {
    const line: CartLine = { productId: 'p', productName: 'P', unitId: 'u', unitName: 'pc', factor: 1, unitPrice: 1000, quantity: 2, lineDiscount: 0, taxRateBp: 1925, isService: false }
    const s = buildSale({
      newId, tenantId: 't', shopId: 's', userId: 'c1', deviceId: 'd', role: 'cashier', saleNumber: 'A1-0003', nowIso: '2026-11-17T09:00:00.000Z',
      lines: [line], payments: [{ method: 'cash', amount: 2385 }], costStates: { p: receive(emptyCostState, 2, 1000) }, oversellPolicy: 'allow_and_flag',
    })
    expect(s.sale.total).toBe(2385) // 2,000 + 19.25% = 2,385 (385 tax)
    const r = buildReturn({ ...actor, sale: s.sale, saleLines: s.lines, priorLines: [], openOnSale: 0, refundableMoney: 2385, reference: 'R',
      request: { kind: 'return', reason: 'x', refundMethod: 'cash', lines: [{ saleLineId: s.lines[0].id, quantity: 1, restock: true }] } })
    expect(r.ret.totalValue + 0).toBeGreaterThan(r.ret.netValue) // refund includes tax
    expect(r.ret.netValue).toBe(1000)
    expect(r.ret.totalValue).toBe(1193) // round(2385 / 2)
  })
})

describe('approval requests', () => {
  it('a cashier files a request; it stays pending until someone decides', () => {
    const req = buildApprovalRequest({ ...actor, userId: 'cashier', saleId: 'sale1', request: { kind: 'return', reason: 'faulty', refundMethod: 'cash', lines: [{ saleLineId: 'l1', quantity: 1, restock: true }] } })
    expect(req.kind).toBe('refund')
    expect(pendingRequests([req], [])).toHaveLength(1)
    const d = buildDecision({ ...actor, requestId: req.id, decision: 'approved', returnId: 'ret1' })
    expect(pendingRequests([req], [d])).toHaveLength(0)
  })
  it('a cancellation request is a reversal; a rejection needs a reason; an empty request is refused', () => {
    expect(buildApprovalRequest({ ...actor, saleId: 's', request: { kind: 'cancellation', reason: 'x', lines: [{ saleLineId: 'l', quantity: 1, restock: true }] } }).kind).toBe('reversal')
    expect(() => buildDecision({ ...actor, requestId: 'r', decision: 'rejected' })).toThrow('why')
    expect(() => buildApprovalRequest({ ...actor, saleId: 's', request: { kind: 'return', reason: 'x', lines: [] } })).toThrow()
  })
})
