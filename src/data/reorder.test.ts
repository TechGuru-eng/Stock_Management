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

const { db, newId } = await import('./db')
const repo = await import('./repo')
const pur = await import('./purchasingRepo')
const sp = await import('./supplierPricesRepo')
const ro = await import('./reorderRepo')
const { DEFAULT_REORDER } = await import('../domain/reorder')

const mgr: import('./repo').Ctx = { tenantId: 't1', shopId: 's1', userId: 'm', role: 'manager', oversellPolicy: 'allow_and_flag' }
const settings = { ...DEFAULT_REORDER, coverDays: 14, windowDays: 30, leadDays: 7 }

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  store.set('stockcm.deviceId', newId())
})

async function shop() {
  const water = await repo.addProduct(mgr, {
    name: 'Eau', baseUnit: 'bouteille', minStock: 6, taxRateBp: 0, isService: false,
    units: [{ name: 'bouteille', factor: 1, sellPrice: 500, isBase: true }, { name: 'carton', factor: 24, sellPrice: 11000, isBase: false }], openingQty: 40, openingTotalCost: 12000,
  })
  const rice = await repo.addProduct(mgr, { name: 'Riz', baseUnit: 'kg', minStock: 0, taxRateBp: 0, isService: false, units: [{ name: 'kg', factor: 1, sellPrice: 800, isBase: true }], openingQty: 100, openingTotalCost: 60000 })
  const unit = async (p: string) => (await db.units.where('productId').equals(p).filter((u) => u.isBase).first())!
  const sell = async (p: string, qty: number) => {
    const u = await unit(p)
    await repo.checkout(mgr, { lines: [{ productId: p, productName: 'x', unitId: u.id, unitName: u.name, factor: 1, unitPrice: u.sellPrice, quantity: qty, lineDiscount: 0, taxRateBp: 0, isService: false }], payments: [{ method: 'cash', amount: qty * u.sellPrice }] })
  }
  return { water, rice, sell, unit }
}

describe('reorder suggestions from real records', () => {
  it('suggests what the shop is selling fast, in cartons, and leaves slow stock alone', async () => {
    const { water, rice, sell } = await shop()
    await sell(water, 30) // 40 -> 10 left, 30 sold in the window = 1/day
    await sell(rice, 3) // 3 kg in 30 days from 97 left: no need
    const v = await ro.loadReorder(mgr, settings)
    expect(v.rows.map((r) => r.productId)).toEqual([water])
    // target = 1 x 14 + 6 minimum = 20, have 10 -> need 10 -> one carton of 24
    expect(v.rows[0]).toMatchObject({ qty: 24, packs: 1, packName: 'carton', onHand: 10, urgency: 'soon' })
  })

  it('an order already placed counts as on its way; a delivery then covers it', async () => {
    const { water, sell, unit } = await shop()
    await sell(water, 30)
    const sup = await pur.addSupplier(mgr, 'Grossiste', '677000111')
    const b = await unit(water)
    const po = await pur.createPurchase(mgr, { supplierId: sup.id, lines: [{ productId: water, unitId: b.id, quantity: 24, totalCost: 7200 }] })
    expect((await ro.loadReorder(mgr, settings)).rows).toEqual([]) // 10 + 24 coming covers the 20 target
    const l = await db.purchaseLines.where('purchaseId').equals(po.purchase.id).toArray()
    await pur.receiveGoods(mgr, po.purchase.id, [{ purchaseLineId: l[0].id, baseQuantity: 24 }])
    expect((await ro.loadReorder(mgr, settings)).rows).toEqual([])
  })

  it('picks the cheapest quoted supplier, prices the order from the quote, and creates the orders', async () => {
    const { water, sell } = await shop()
    await sell(water, 36) // 4 left, 1.2/day: out soon
    const a = await pur.addSupplier(mgr, 'Grossiste A')
    const bsup = await pur.addSupplier(mgr, 'Marché')
    const carton = (await db.units.where('productId').equals(water).filter((u) => !u.isBase).first())!
    await sp.setSupplierPrice(mgr, { supplierId: a.id, productId: water, unitId: carton.id, price: 7200 })
    await sp.setSupplierPrice(mgr, { supplierId: bsup.id, productId: water, unitId: carton.id, price: 6000 })
    const v = await ro.loadReorder(mgr, settings)
    const row = v.rows[0]
    expect(row).toMatchObject({ supplierId: bsup.id, costSource: 'quote', unitCost: 250 })
    expect(v.groups[0].supplierId).toBe(bsup.id)

    const res = await ro.createOrdersFromSuggestions(mgr, [{ supplierId: bsup.id, lines: [{ productId: water, qty: row.qty, totalCost: row.estimate! }] }])
    expect(res.failed).toEqual([])
    const lines = await db.purchaseLines.toArray()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ productId: water, baseQuantity: row.qty, totalCost: row.estimate })
    // an order moves no stock and creates no debt until the goods arrive
    expect((await db.costs.get(`s1:${water}`))!.quantity).toBe(4)
    expect(await db.supplierEntries.count()).toBe(0)
  })

  it('without any supplier price it estimates from the shop average cost and says so', async () => {
    const { water, sell } = await shop()
    await sell(water, 36)
    const row = (await ro.loadReorder(mgr, settings)).rows[0]
    expect(row).toMatchObject({ supplierId: null, costSource: 'average' })
    expect(row.unitCost).toBe(Math.round((12000 - 36 * 300) / 4)) // value left / quantity left
  })

  it('this shop only: another shop\'s sales do not drive this shop\'s orders', async () => {
    const { water, sell } = await shop()
    await sell(water, 30)
    const other = (await ro.loadReorder({ ...mgr, shopId: 's2' }, settings)).rows
    expect(other.map((r) => [r.speed, r.urgency])).toEqual([[0, 'low']]) // nothing sold here: only the minimum stock asks for it
  })

  it('needs the right to manage purchases to create orders', async () => {
    const { water } = await shop()
    const sup = await pur.addSupplier(mgr, 'Grossiste')
    await expect(ro.createOrdersFromSuggestions({ ...mgr, role: 'cashier' }, [{ supplierId: sup.id, lines: [{ productId: water, qty: 1, totalCost: 1 }] }])).rejects.toThrow(/not allowed/)
  })
})
