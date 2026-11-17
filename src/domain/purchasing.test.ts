import { describe, expect, it } from 'vitest'
import {
  buildPurchase, buildReceipt, buildSupplierPayment, buildSupplierReturn, purchaseStatus, supplierBalance, supplierStatement,
  type ReceiptLineRecord, type SupplierEntryRecord,
} from './purchasing'
import { PaymentError } from './payments'

let n = 0
const newId = () => `id-${++n}`
const actor = { newId, tenantId: 't', shopId: 's', userId: 'u', deviceId: 'd', nowIso: '2026-11-17T09:00:00.000Z' }

function order() {
  return buildPurchase({
    ...actor, supplierId: 'sup1', invoiceNumber: 'INV-77',
    lines: [{ productId: 'rice', baseQuantity: 3, totalCost: 1000 }, { productId: 'oil', baseQuantity: 10, totalCost: 25000 }],
  })
}

describe('purchase order', () => {
  it('records what was asked for and nothing else', () => {
    const o = order()
    expect(o.purchase.invoiceNumber).toBe('INV-77')
    expect(o.lines).toHaveLength(2)
    // An order has no stock movements and no supplier debt: those only come from a receipt.
    expect(Object.keys(o)).toEqual(['purchase', 'lines'])
  })
  it('rejects an empty order and bad quantities', () => {
    expect(() => buildPurchase({ ...actor, supplierId: 's', lines: [] })).toThrow(PaymentError)
    expect(() => buildPurchase({ ...actor, supplierId: 's', lines: [{ productId: 'p', baseQuantity: 0, totalCost: 10 }] })).toThrow(PaymentError)
    expect(() => buildPurchase({ ...actor, supplierId: 's', lines: [{ productId: 'p', baseQuantity: 2.5, totalCost: 10 }] })).toThrow(PaymentError)
  })
})

describe('goods receipt (test 18: delivered in several parts)', () => {
  it('stock and debt appear only on receipt, and the parts add up exactly to the order cost', () => {
    const o = order()
    const rice = o.lines[0]
    const prior: ReceiptLineRecord[] = []
    const costs: number[] = []
    for (let i = 0; i < 3; i++) {
      const r = buildReceipt({ ...actor, purchase: o.purchase, lines: o.lines, priorReceiptLines: prior, deliveries: [{ purchaseLineId: rice.id, baseQuantity: 1 }] })
      prior.push(...r.lines)
      costs.push(r.receivedCost)
      expect(r.movements[0].type).toBe('purchase_receipt')
      expect(r.movements[0].quantity).toBe(1)
    }
    expect(costs).toEqual([333, 334, 333]) // never 999 or 1001
    expect(costs.reduce((a, b) => a + b, 0)).toBe(1000)
  })

  it('status follows what really arrived', () => {
    const o = order()
    expect(purchaseStatus(o.lines, [])).toBe('ordered')
    const first = buildReceipt({ ...actor, purchase: o.purchase, lines: o.lines, priorReceiptLines: [], deliveries: [{ purchaseLineId: o.lines[0].id, baseQuantity: 3 }] })
    expect(purchaseStatus(o.lines, first.lines)).toBe('partially_received') // oil not here yet
    const second = buildReceipt({ ...actor, purchase: o.purchase, lines: o.lines, priorReceiptLines: first.lines, deliveries: [{ purchaseLineId: o.lines[1].id, baseQuantity: 10 }] })
    expect(purchaseStatus(o.lines, [...first.lines, ...second.lines])).toBe('received')
  })

  it('refuses to receive more than was ordered, or nothing at all', () => {
    const o = order()
    expect(() => buildReceipt({ ...actor, purchase: o.purchase, lines: o.lines, priorReceiptLines: [], deliveries: [{ purchaseLineId: o.lines[0].id, baseQuantity: 4 }] })).toThrow('more than ordered')
    expect(() => buildReceipt({ ...actor, purchase: o.purchase, lines: o.lines, priorReceiptLines: [], deliveries: [] })).toThrow('nothing')
  })

  it('buying on credit records the debt; paying part on the spot records a separate payment', () => {
    const o = order()
    const r = buildReceipt({
      ...actor, purchase: o.purchase, lines: o.lines, priorReceiptLines: [],
      deliveries: [{ purchaseLineId: o.lines[1].id, baseQuantity: 10 }], // oil: 25,000
      paidNow: { amount: 10000, method: 'cash', reference: 'SP-1' },
    })
    expect(r.receivedCost).toBe(25000)
    expect(supplierBalance(r.entries)).toBe(15000) // 25,000 owed - 10,000 paid
    expect(r.payment).toMatchObject({ txnType: 'supplier_payment', amount: -10000, verification: 'recorded' })
    expect(r.entries.map((e) => e.kind)).toEqual(['purchase_credit', 'payment'])
  })

  it('cannot pay more than the value just received', () => {
    const o = order()
    expect(() => buildReceipt({
      ...actor, purchase: o.purchase, lines: o.lines, priorReceiptLines: [], deliveries: [{ purchaseLineId: o.lines[0].id, baseQuantity: 3 }],
      paidNow: { amount: 5000, method: 'cash', reference: 'x' },
    })).toThrow(PaymentError)
  })
})

describe('supplier payments and statement (test 4)', () => {
  const credit: SupplierEntryRecord = { id: 'e1', tenantId: 't', supplierId: 'sup1', amount: 50000, kind: 'purchase_credit', occurredAt: '2026-11-01T08:00:00Z' }

  it('partial payments lower the debt step by step', () => {
    const p1 = buildSupplierPayment({ ...actor, supplierId: 'sup1', amount: 20000, method: 'mtn_momo', reference: 'SP-2', payable: 50000 })
    const p2 = buildSupplierPayment({ ...actor, nowIso: '2026-11-18T09:00:00.000Z', supplierId: 'sup1', amount: 5000, method: 'cash', reference: 'SP-3', payable: 30000 })
    expect(p1.transaction.amount).toBe(-20000)
    expect(supplierBalance([credit, p1.entry, p2.entry])).toBe(25000)
  })

  it('refuses to pay more than is owed', () => {
    expect(() => buildSupplierPayment({ ...actor, supplierId: 's', amount: 50001, method: 'cash', reference: 'x', payable: 50000 })).toThrow('more than we owe')
  })

  it('a statement shows a running balance in order', () => {
    const pay = buildSupplierPayment({ ...actor, nowIso: '2026-11-05T08:00:00Z', supplierId: 'sup1', amount: 20000, method: 'cash', reference: 'x', payable: 50000 })
    const ret = buildSupplierReturn({
      ...actor, nowIso: '2026-11-09T08:00:00Z', supplierId: 'sup1', productId: 'rice', baseQuantity: 2, removedValue: 1800, creditValue: 2000, reason: 'damaged bags',
    })
    const rows = supplierStatement([ret.entry, pay.entry, credit])
    expect(rows.map((r) => [r.entry.kind, r.balance])).toEqual([['purchase_credit', 50000], ['payment', 30000], ['return', 28000]])
  })
})

describe('returns to a supplier', () => {
  it('takes stock out and credits what the supplier owes us', () => {
    const r = buildSupplierReturn({ ...actor, supplierId: 'sup1', productId: 'rice', baseQuantity: 2, removedValue: 1800, creditValue: 2000, reason: 'damaged' })
    expect(r.movement).toMatchObject({ type: 'supplier_return', quantity: -2, totalCost: 1800 })
    expect(r.entry).toMatchObject({ kind: 'return', amount: -2000 })
  })
  it('needs a reason', () => {
    expect(() => buildSupplierReturn({ ...actor, supplierId: 's', productId: 'p', baseQuantity: 1, removedValue: 1, creditValue: 1, reason: ' ' })).toThrow('reason')
  })
})
