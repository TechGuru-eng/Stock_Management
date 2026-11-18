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
const imp = await import('./importRepo')
const { parseCsv } = await import('../domain/csvParse')
const { planSupplierImport } = await import('../domain/supplierPriceImport')
const { currentQuotes, lastPaid } = await import('../domain/supplierPrices')
const engine = await import('../sync/engine')
const { FakeServer } = await import('../sync/testing/fakeServer')
const { getSyncSummary } = await import('../sync/status')

const mgr: import('./repo').Ctx = { tenantId: 't1', shopId: 's1', userId: 'm', role: 'manager', oversellPolicy: 'allow_and_flag' }
const sctx = { tenantId: 't1', deviceName: 'Phone' }
let server: InstanceType<typeof FakeServer>

async function newDevice() {
  await Promise.all(db.tables.map((t) => t.clear()))
  store.set('stockcm.deviceId', newId())
}
beforeEach(async () => {
  server = new FakeServer()
  await newDevice()
})

async function setup() {
  const water = await repo.addProduct(mgr, {
    name: 'Eau', barcode: '5449000000996', baseUnit: 'bouteille', minStock: 0, taxRateBp: 0, isService: false,
    units: [{ name: 'bouteille', factor: 1, sellPrice: 500, isBase: true }, { name: 'carton', factor: 24, sellPrice: 11000, isBase: false }], openingQty: 0, openingTotalCost: 0,
  })
  const units = await db.units.where('productId').equals(water).toArray()
  const supplier = await pur.addSupplier(mgr, 'Grossiste', '677000111')
  return { water, supplier: supplier.id, bottle: units.find((u) => u.isBase)!, carton: units.find((u) => !u.isBase)! }
}

describe('recording quotes', () => {
  it('a new quote is a new line; the newest is current; the same price again changes nothing', async () => {
    const { water, supplier, carton } = await setup()
    const ref = { supplierId: supplier, productId: water, unitId: carton.id }
    expect(await sp.setSupplierPrice(mgr, { ...ref, price: 7000 })).not.toBeNull()
    expect(await sp.setSupplierPrice(mgr, { ...ref, price: 7000 })).toBeNull()
    await new Promise((r) => setTimeout(r, 5))
    await sp.setSupplierPrice(mgr, { ...ref, price: 7350 })
    const all = await db.supplierPrices.toArray()
    expect(all).toHaveLength(2) // history kept
    expect(currentQuotes(all).get(`${supplier}|${water}|${carton.id}`)!.price).toBe(7350)
  })

  it('refuses bad prices, a unit of another product, an unknown supplier, and people without the right', async () => {
    const { water, supplier, carton } = await setup()
    const other = await repo.addProduct(mgr, { name: 'Riz', baseUnit: 'kg', minStock: 0, taxRateBp: 0, isService: false, units: [{ name: 'kg', factor: 1, sellPrice: 800, isBase: true }], openingQty: 0, openingTotalCost: 0 })
    const riceUnit = (await db.units.where('productId').equals(other).first())!
    await expect(sp.setSupplierPrice(mgr, { supplierId: supplier, productId: water, unitId: carton.id, price: -1 })).rejects.toThrow(/whole number/)
    await expect(sp.setSupplierPrice(mgr, { supplierId: supplier, productId: water, unitId: carton.id, price: 10.5 })).rejects.toThrow(/whole number/)
    await expect(sp.setSupplierPrice(mgr, { supplierId: supplier, productId: water, unitId: riceUnit.id, price: 5 })).rejects.toThrow(/does not belong/)
    await expect(sp.setSupplierPrice(mgr, { supplierId: 'ghost', productId: water, unitId: carton.id, price: 5 })).rejects.toThrow(/supplier not found/)
    await expect(sp.setSupplierPrice({ ...mgr, role: 'cashier' }, { supplierId: supplier, productId: water, unitId: carton.id, price: 5 })).rejects.toThrow(/not allowed/)
    await expect(sp.setSupplierPrice({ ...mgr, role: 'storekeeper' }, { supplierId: supplier, productId: water, unitId: carton.id, price: 5 })).rejects.toThrow(/not allowed/)
  })
})

describe('importing a supplier price list', () => {
  it('saves new and changed quotes, holds big jumps for a yes, and the history keeps the old price', async () => {
    const { water, supplier, carton } = await setup()
    await sp.setSupplierPrice(mgr, { supplierId: supplier, productId: water, unitId: carton.id, price: 7000 })
    await new Promise((r) => setTimeout(r, 5))
    const run = async (csv: string, includeFlagged = false) => {
      const quotes = currentQuotes(await db.supplierPrices.toArray())
      const plan = planSupplierImport(parseCsv(csv), await imp.loadKnownProducts(), (p, u) => quotes.get(`${supplier}|${p}|${u}`)?.price ?? null)
      return sp.applySupplierImport(mgr, supplier, plan, { includeFlagged })
    }
    expect(await run('name;unit;price\nEau;bouteille;290\nEau;carton;7 350')).toMatchObject({ saved: 2, skipped: 0, failed: [] })
    expect(await run('name;unit;price\nEau;carton;12 000')).toMatchObject({ saved: 0, skipped: 1 })
    expect(await run('name;unit;price\nEau;carton;12 000', true)).toMatchObject({ saved: 1 })
    const history = (await db.supplierPrices.toArray()).filter((r) => r.unitId === carton.id).map((r) => r.price).sort((a, b) => a - b)
    expect(history).toEqual([7000, 7350, 12000])
  })
})

describe('what was paid is known from deliveries', () => {
  it('the last delivery gives the real cost per base unit for that supplier', async () => {
    const { water, supplier, bottle } = await setup()
    const po = await pur.createPurchase(mgr, { supplierId: supplier, lines: [{ productId: water, unitId: bottle.id, quantity: 48, totalCost: 14400 }] })
    const lines = await db.purchaseLines.where('purchaseId').equals(po.purchase.id).toArray()
    await pur.receiveGoods(mgr, po.purchase.id, [{ purchaseLineId: lines[0].id, baseQuantity: 48 }])
    const paid = lastPaid(await db.purchases.toArray(), await db.receipts.toArray(), await db.receiptLines.toArray())
    expect(paid.get(`${supplier}|${water}`)!.baseCost).toBe(300)
  })
})

describe('sync', () => {
  it('quotes reach the server and a second device', async () => {
    const { water, supplier, carton } = await setup()
    await sp.setSupplierPrice(mgr, { supplierId: supplier, productId: water, unitId: carton.id, price: 7000 })
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).pendingGroups).toBe(0)
    expect(server.count('supplier_prices')).toBe(1)
    await newDevice()
    await engine.runSync(server, sctx)
    expect((await db.supplierPrices.toArray()).map((r) => r.price)).toEqual([7000])
  })
})
