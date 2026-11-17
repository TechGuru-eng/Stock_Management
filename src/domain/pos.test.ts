import { describe, expect, it } from 'vitest'
import { buildSale, cartTotals, type CartLine, type CheckoutInput } from './pos'
import { receive, emptyCostState } from './costing'
import { PaymentError } from './payments'
import { can, discountNeedsApproval } from './permissions'

let n = 0
const newId = () => `id-${++n}`

const bottleLine: CartLine = {
  productId: 'water', productName: 'Eau 1.5L', unitId: 'bottle', unitName: 'bottle',
  factor: 1, unitPrice: 500, quantity: 3, lineDiscount: 0, taxRateBp: 0, isService: false,
}

// 2 cartons of 24 bottles bought for 24,000 XAF in total => 500 XAF per bottle cost
const stocked = receive(emptyCostState, 48, 24000)

function input(over: Partial<CheckoutInput> = {}): CheckoutInput {
  return {
    newId, tenantId: 't', shopId: 's', userId: 'u', deviceId: 'd', role: 'cashier',
    saleNumber: 'A1B2-0001', nowIso: '2026-11-17T09:00:00Z',
    lines: [bottleLine], payments: [{ method: 'cash', amount: 1500 }],
    costStates: { water: stocked }, oversellPolicy: 'allow_and_flag',
    ...over,
  }
}

describe('cart totals', () => {
  it('adds line discounts and tax on the discounted amount', () => {
    const t = cartTotals([{ ...bottleLine, quantity: 10, lineDiscount: 500, taxRateBp: 1925 }])
    // gross 5000, net 4500, tax 19.25% = 866.25 -> 866
    expect(t).toEqual({ subtotal: 5000, discount: 500, tax: 866, total: 5366 })
  })
})

describe('checkout', () => {
  it('selling 3 bottles deducts 3 base units and costs them', () => {
    const r = buildSale(input())
    expect(r.movements).toHaveLength(1)
    expect(r.movements[0].quantity).toBe(-3)
    expect(r.newCostStates.water.quantity).toBe(45)
    expect(r.lines[0].costOfGoods).toBe(1500)
    expect(r.sale.total).toBe(1500)
    expect(r.sale.collected).toBe(1500)
    expect(r.sale.outstanding).toBe(0)
  })

  it('selling 1 carton (24 bottles) deducts 24 base units', () => {
    const r = buildSale(input({
      lines: [{ ...bottleLine, unitId: 'carton', unitName: 'carton', factor: 24, unitPrice: 11000, quantity: 1 }],
      payments: [{ method: 'cash', amount: 11000 }],
    }))
    expect(r.movements[0].quantity).toBe(-24)
    expect(r.lines[0].baseQuantity).toBe(24)
  })

  it('30,000 sale: 10,000 cash + 5,000 MTN + 15,000 credit', () => {
    const r = buildSale(input({
      lines: [{ ...bottleLine, unitPrice: 10000, quantity: 3 }],
      payments: [
        { method: 'cash', amount: 10000 },
        { method: 'mtn_momo', amount: 5000 },
        { method: 'credit', amount: 15000 },
      ],
      customer: { id: 'c1', creditLimit: 50000, balance: 0 },
    }))
    expect(r.sale.total).toBe(30000)
    expect(r.sale.collected).toBe(15000)
    expect(r.sale.outstanding).toBe(15000)
    expect(r.transactions.map((t) => [t.method, t.amount])).toEqual([['cash', 10000], ['mtn_momo', 5000]])
    expect(r.customerEntry?.amount).toBe(15000)
    // manual MoMo is only "recorded"
    expect(r.transactions.every((t) => t.verification === 'recorded')).toBe(true)
  })

  it('refuses credit above the customer limit', () => {
    expect(() => buildSale(input({
      payments: [{ method: 'credit', amount: 1500 }],
      customer: { id: 'c1', creditLimit: 2000, balance: 1000 },
    }))).toThrow('credit limit')
  })

  it('refuses credit with no customer and payments that do not add up', () => {
    expect(() => buildSale(input({ payments: [{ method: 'credit', amount: 1500 }] }))).toThrow(PaymentError)
    expect(() => buildSale(input({ payments: [{ method: 'cash', amount: 1000 }] }))).toThrow(PaymentError)
  })

  it('flags an oversell offline but still completes it', () => {
    const r = buildSale(input({ lines: [{ ...bottleLine, quantity: 50 }], payments: [{ method: 'cash', amount: 25000 }] }))
    expect(r.oversoldProductIds).toEqual(['water'])
    expect(r.newCostStates.water.quantity).toBe(-2)
  })

  it('blocks the oversell when the shop policy is block', () => {
    expect(() => buildSale(input({
      lines: [{ ...bottleLine, quantity: 50 }], payments: [{ method: 'cash', amount: 25000 }], oversellPolicy: 'block',
    }))).toThrow('not enough stock')
  })

  it('services do not touch stock', () => {
    const r = buildSale(input({
      lines: [{ ...bottleLine, productId: 'svc', isService: true, unitPrice: 2000, quantity: 1 }],
      payments: [{ method: 'cash', amount: 2000 }],
    }))
    expect(r.movements).toHaveLength(0)
  })

  it('a cashier cannot give a large discount; a manager can', () => {
    const big: CartLine = { ...bottleLine, lineDiscount: 600 } // 40% of 1500
    expect(() => buildSale(input({ lines: [big], payments: [{ method: 'cash', amount: 900 }] }))).toThrow('approval')
    expect(buildSale(input({ role: 'manager', lines: [big], payments: [{ method: 'cash', amount: 900 }] })).sale.total).toBe(900)
  })

  it('an empty cart is refused', () => {
    expect(() => buildSale(input({ lines: [], payments: [] }))).toThrow(PaymentError)
  })
})

describe('permissions', () => {
  it('cashiers cannot receive stock or change prices; owners can do anything', () => {
    expect(can('cashier', 'sales.create')).toBe(true)
    expect(can('cashier', 'stock.receive')).toBe(false)
    expect(can('cashier', 'products.write')).toBe(false)
    expect(can('owner', 'anything.at.all')).toBe(true)
    expect(can('storekeeper', 'stock.receive')).toBe(true)
  })
  it('10% is the cashier discount limit', () => {
    expect(discountNeedsApproval(1000, 100, 'cashier')).toBe(false)
    expect(discountNeedsApproval(1000, 101, 'cashier')).toBe(true)
    expect(discountNeedsApproval(1000, 900, 'manager')).toBe(false)
  })
})
