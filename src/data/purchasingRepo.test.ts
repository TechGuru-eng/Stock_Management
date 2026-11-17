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
const pur = await import('./purchasingRepo')
const { purchaseStatus, supplierStatement } = await import('../domain/purchasing')

const owner: import('./repo').Ctx = { tenantId: 't1', shopId: 's1', userId: 'owner', role: 'owner', oversellPolicy: 'allow_and_flag' }
const storekeeper: import('./repo').Ctx = { ...owner, userId: 'sk', role: 'storekeeper' }
const cashier: import('./repo').Ctx = { ...owner, userId: 'c', role: 'cashier' }

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

async function rice() {
  const id = await repo.addProduct(owner, {
    name: 'Riz 25kg', baseUnit: 'sac', minStock: 2, taxRateBp: 0, isService: false,
    units: [{ name: 'sac', factor: 1, sellPrice: 15000, isBase: true }], openingQty: 0, openingTotalCost: 0,
  })
  const unit = (await db.units.where('productId').equals(id).first())!
  return { id, unit }
}
const stock = async (pid: string) => (await db.costs.get(`s1:${pid}`))?.quantity ?? 0

describe('purchase order does nothing until goods arrive', () => {
  it('creating an order changes no stock and no supplier debt', async () => {
    const p = await rice()
    const sup = await pur.addSupplier(owner, 'Grossiste Akwa')
    const before = await db.movements.count()
    const o = await pur.createPurchase(owner, { supplierId: sup.id, invoiceNumber: 'F-12', lines: [{ productId: p.id, unitId: p.unit.id, quantity: 10, totalCost: 100000 }] })
    expect(await db.movements.count()).toBe(before)
    expect(await stock(p.id)).toBe(0)
    expect(await pur.supplierPayable(sup.id)).toBe(0)
    expect(purchaseStatus(o.lines, [])).toBe('ordered')
  })
})

describe('receiving goods in several deliveries (test 18)', () => {
  it('stock and debt follow each delivery; the order completes only when everything has arrived', async () => {
    const p = await rice()
    const sup = await pur.addSupplier(owner, 'Grossiste Akwa')
    const o = await pur.createPurchase(owner, { supplierId: sup.id, lines: [{ productId: p.id, unitId: p.unit.id, quantity: 10, totalCost: 100000 }] })
    const line = o.lines[0]

    await pur.receiveGoods(storekeeper, o.purchase.id, [{ purchaseLineId: line.id, baseQuantity: 4 }])
    expect(await stock(p.id)).toBe(4)
    expect(await pur.supplierPayable(sup.id)).toBe(40000)

    await pur.receiveGoods(storekeeper, o.purchase.id, [{ purchaseLineId: line.id, baseQuantity: 6 }])
    expect(await stock(p.id)).toBe(10)
    expect(await pur.supplierPayable(sup.id)).toBe(100000)
    const cost = (await db.costs.get(`s1:${p.id}`))!
    expect(cost.value).toBe(100000) // weighted-average value equals what was paid for

    const receiptLines = await db.receiptLines.toArray()
    expect(purchaseStatus(o.lines, receiptLines)).toBe('received')
    await expect(pur.receiveGoods(storekeeper, o.purchase.id, [{ purchaseLineId: line.id, baseQuantity: 1 }])).rejects.toThrow('more than ordered')
    expect(await stock(p.id)).toBe(10)
  })

  it('each delivery is one atomic group, with the debt and stock together', async () => {
    const p = await rice()
    const sup = await pur.addSupplier(owner, 'Grossiste G')
    const o = await pur.createPurchase(owner, { supplierId: sup.id, lines: [{ productId: p.id, unitId: p.unit.id, quantity: 5, totalCost: 50000 }] })
    const before = await db.outbox.count()
    await pur.receiveGoods(owner, o.purchase.id, [{ purchaseLineId: o.lines[0].id, baseQuantity: 5 }], { amount: 20000, method: 'cash' })
    const rows = (await db.outbox.toArray()).slice(before)
    expect(rows.map((r) => r.table)).toEqual([
      'financial_transactions', 'goods_receipts', 'goods_receipt_lines', 'stock_movements', 'supplier_account_entries', 'supplier_account_entries',
    ])
    expect(new Set(rows.map((r) => r.groupId)).size).toBe(1)
    expect(await pur.supplierPayable(sup.id)).toBe(30000) // received 50,000, paid 20,000 now
  })
})

describe('supplier payments, returns and statement (test 4)', () => {
  it('partial payments, a return, and a statement whose running balance ends where it should', async () => {
    const p = await rice()
    const sup = await pur.addSupplier(owner, 'Grossiste Akwa')
    const o = await pur.createPurchase(owner, { supplierId: sup.id, lines: [{ productId: p.id, unitId: p.unit.id, quantity: 10, totalCost: 100000 }] })
    await pur.receiveGoods(owner, o.purchase.id, [{ purchaseLineId: o.lines[0].id, baseQuantity: 10 }])
    await pur.paySupplier(owner, { supplierId: sup.id, amount: 30000, method: 'mtn_momo' })
    await pur.paySupplier(owner, { supplierId: sup.id, amount: 20000, method: 'cash' })
    expect(await pur.supplierPayable(sup.id)).toBe(50000)

    await pur.returnToSupplier(owner, { supplierId: sup.id, productId: p.id, baseQuantity: 2, creditValue: 18000, reason: 'torn bags' })
    expect(await stock(p.id)).toBe(8)
    expect((await db.costs.get(`s1:${p.id}`))!.value).toBe(80000)
    expect(await pur.supplierPayable(sup.id)).toBe(32000)

    const rows = supplierStatement(await db.supplierEntries.toArray())
    expect(rows.map((r) => r.entry.kind)).toEqual(['purchase_credit', 'payment', 'payment', 'return'])
    expect(rows.at(-1)!.balance).toBe(32000)

    await expect(pur.paySupplier(owner, { supplierId: sup.id, amount: 32001, method: 'cash' })).rejects.toThrow('more than we owe')
    await expect(pur.returnToSupplier(owner, { supplierId: sup.id, productId: p.id, baseQuantity: 99, creditValue: 1, reason: 'x' })).rejects.toThrow('not enough stock')
    const txn = (await db.transactions.toArray()).find((t) => t.method === 'mtn_momo')!
    expect(txn).toMatchObject({ txnType: 'supplier_payment', amount: -30000, verification: 'recorded' })
  })
})

describe('permissions', () => {
  it('a storekeeper can receive goods but cannot order, pay or add suppliers; a cashier can do none', async () => {
    const p = await rice()
    const sup = await pur.addSupplier(owner, 'Grossiste G')
    const o = await pur.createPurchase(owner, { supplierId: sup.id, lines: [{ productId: p.id, unitId: p.unit.id, quantity: 2, totalCost: 2000 }] })
    await expect(pur.createPurchase(storekeeper, { supplierId: sup.id, lines: [{ productId: p.id, unitId: p.unit.id, quantity: 1, totalCost: 1 }] })).rejects.toThrow('permission')
    await expect(pur.addSupplier(storekeeper, 'X Y')).rejects.toThrow('permission')
    await expect(pur.receiveGoods(storekeeper, o.purchase.id, [{ purchaseLineId: o.lines[0].id, baseQuantity: 1 }], { amount: 500, method: 'cash' })).rejects.toThrow('permission')
    await expect(pur.receiveGoods(cashier, o.purchase.id, [{ purchaseLineId: o.lines[0].id, baseQuantity: 1 }])).rejects.toThrow('permission')
    await expect(pur.receiveGoods(storekeeper, o.purchase.id, [{ purchaseLineId: o.lines[0].id, baseQuantity: 1 }])).resolves.toBeTruthy()
  })
})
