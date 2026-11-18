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
const ed = await import('./productsRepo')
const pur = await import('./purchasingRepo')
const bx = await import('./batchesRepo')
const engine = await import('../sync/engine')
const { FakeServer } = await import('../sync/testing/fakeServer')
const { getSyncSummary } = await import('../sync/status')

const mgr: import('./repo').Ctx = { tenantId: 't1', shopId: 's1', userId: 'm', role: 'manager', oversellPolicy: 'allow_and_flag' }
const sctx = { tenantId: 't1', deviceName: 'Phone' }
let server: InstanceType<typeof FakeServer>
const iso = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

async function newDevice() {
  await Promise.all(db.tables.map((t) => t.clear()))
  store.set('stockcm.deviceId', newId())
}
beforeEach(async () => {
  server = new FakeServer()
  await newDevice()
})

const milk = (over: Partial<import('./repo').NewProductInput> = {}) => repo.addProduct(mgr, {
  name: 'Lait', baseUnit: 'boîte', minStock: 0, taxRateBp: 0, isService: false, trackExpiry: true,
  units: [{ name: 'boîte', factor: 1, sellPrice: 600, isBase: true }, { name: 'carton', factor: 12, sellPrice: 6500, isBase: false }], openingQty: 0, openingTotalCost: 0, ...over,
})
const qty = async (p: string) => (await db.costs.get(`s1:${p}`))?.quantity ?? 0
const sell = async (p: string, n: number) => {
  const u = (await db.units.where('productId').equals(p).filter((x) => x.isBase).first())!
  await repo.checkout(mgr, { lines: [{ productId: p, productName: 'x', unitId: u.id, unitName: u.name, factor: 1, unitPrice: 600, quantity: n, lineDiscount: 0, taxRateBp: 0, isService: false }], payments: [{ method: 'cash', amount: n * 600 }] })
}

describe('recording dated stock', () => {
  it('opening stock and deliveries carry their dates; stock figures are unchanged by it', async () => {
    const id = await milk({ openingQty: 24, openingTotalCost: 7200, openingExpiry: iso(10) })
    const carton = (await db.units.where('productId').equals(id).filter((u) => !u.isBase).first())!
    await repo.receiveStock(mgr, id, carton, 2, 9600, iso(120)) // 2 cartons = 24 boîtes
    expect(await qty(id)).toBe(48)
    const batches = await db.stockBatches.toArray()
    expect(batches.map((b) => [b.quantity, b.expiry]).sort()).toEqual([[24, iso(10)], [24, iso(120)]].sort())
  })

  it('refuses dates for a product that does not track them, and dates that are not real', async () => {
    const plain = await milk({ trackExpiry: false })
    const unit = (await db.units.where('productId').equals(plain).filter((u) => u.isBase).first())!
    await expect(repo.receiveStock(mgr, plain, unit, 5, 100, iso(10))).rejects.toThrow(/does not track/)
    const tracked = await milk({ name: 'Yaourt' })
    const u2 = (await db.units.where('productId').equals(tracked).filter((u) => u.isBase).first())!
    await expect(repo.receiveStock(mgr, tracked, u2, 5, 100, '2026-02-30')).rejects.toThrow(/not valid/)
    expect(await qty(plain)).toBe(0) // nothing half-recorded
    expect(await qty(tracked)).toBe(0)
  })

  it('a delivery against an order can carry the date of each line', async () => {
    const id = await milk()
    const sup = await pur.addSupplier(mgr, 'Laiterie')
    const u = (await db.units.where('productId').equals(id).filter((x) => x.isBase).first())!
    const po = await pur.createPurchase(mgr, { supplierId: sup.id, lines: [{ productId: id, unitId: u.id, quantity: 30, totalCost: 9000 }] })
    const l = await db.purchaseLines.where('purchaseId').equals(po.purchase.id).toArray()
    await pur.receiveGoods(mgr, po.purchase.id, [{ purchaseLineId: l[0].id, baseQuantity: 20, expiry: iso(15) }])
    await pur.receiveGoods(mgr, po.purchase.id, [{ purchaseLineId: l[0].id, baseQuantity: 10, expiry: iso(60) }])
    expect((await db.stockBatches.toArray()).map((b) => b.quantity).sort()).toEqual([10, 20])
    expect(await qty(id)).toBe(30)
  })

  it('tracking can be switched on later for a product', async () => {
    const id = await milk({ trackExpiry: false, openingQty: 5, openingTotalCost: 100 })
    await ed.updateProduct(mgr, id, { trackExpiry: true })
    const unit = (await db.units.where('productId').equals(id).filter((u) => u.isBase).first())!
    await repo.receiveStock(mgr, id, unit, 5, 100, iso(30))
    expect(await db.stockBatches.count()).toBe(1)
  })
})

describe('what is expired or about to be', () => {
  it('lists expired and soon-to-expire batches; sales use the oldest first', async () => {
    const id = await milk({ openingQty: 10, openingTotalCost: 3000, openingExpiry: iso(-2) }) // already expired
    const unit = (await db.units.where('productId').equals(id).filter((u) => u.isBase).first())!
    await repo.receiveStock(mgr, id, unit, 10, 3000, iso(10)) // soon
    await repo.receiveStock(mgr, id, unit, 10, 3000, iso(200)) // fine
    let r = (await bx.loadExpiry(mgr)).rows
    expect(r.map((x) => [x.status, x.quantity])).toEqual([['expired', 10], ['soon', 10]])
    await sell(id, 4) // the oldest (expired) goes first
    r = (await bx.loadExpiry(mgr)).rows
    expect(r.map((x) => [x.status, x.quantity])).toEqual([['expired', 6], ['soon', 10]])
  })

  it('writing off expired goods removes them from stock at their cost, and nothing else', async () => {
    const id = await milk({ openingQty: 10, openingTotalCost: 3000, openingExpiry: iso(-2) })
    const unit = (await db.units.where('productId').equals(id).filter((u) => u.isBase).first())!
    await repo.receiveStock(mgr, id, unit, 10, 5000, iso(100))
    expect(await bx.writeOffExpired(mgr, id)).toBe(10)
    expect(await qty(id)).toBe(10)
    expect((await db.costs.get(`s1:${id}`))!.value).toBe(4000) // 8000 - 10 x 400 average
    expect((await db.movements.filter((m) => m.type === 'expired').toArray()).map((m) => m.quantity)).toEqual([-10])
    expect((await bx.loadExpiry(mgr)).rows).toEqual([]) // the expired batch is gone, the good one is not touched
    expect(await bx.writeOffExpired(mgr, id)).toBe(0) // nothing more to write off
  })

  it('write-off needs the right to adjust stock; "all expired" covers every product', async () => {
    const a = await milk({ openingQty: 5, openingTotalCost: 500, openingExpiry: iso(-1) })
    const b = await milk({ name: 'Yaourt', openingQty: 7, openingTotalCost: 700, openingExpiry: iso(-5) })
    await expect(bx.writeOffExpired({ ...mgr, role: 'storekeeper' }, a)).rejects.toThrow(/not allowed/)
    expect(await bx.writeOffAllExpired(mgr)).toEqual({ products: 2, units: 12 })
    expect([await qty(a), await qty(b)]).toEqual([0, 0])
  })

  it('is per shop and the warning time is a setting', async () => {
    const id = await milk({ openingQty: 5, openingTotalCost: 500, openingExpiry: iso(20) })
    expect((await bx.loadExpiry(mgr)).rows).toHaveLength(1) // within the default 30 days
    await bx.saveWarnDays(10)
    expect((await bx.loadExpiry(mgr)).rows).toHaveLength(0)
    await bx.saveWarnDays(9999)
    expect(await bx.loadWarnDays()).toBe(365)
    expect((await bx.loadExpiry({ ...mgr, shopId: 's2' })).rows).toEqual([])
    void id
  })
})

describe('sync', () => {
  it('batches and the tracking flag reach the server and a second device, which derives the same remaining stock', async () => {
    const id = await milk({ openingQty: 10, openingTotalCost: 3000, openingExpiry: iso(-2) })
    const unit = (await db.units.where('productId').equals(id).filter((u) => u.isBase).first())!
    await repo.receiveStock(mgr, id, unit, 10, 3000, iso(10))
    await sell(id, 3)
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).pendingGroups).toBe(0)
    expect(server.count('stock_batches')).toBe(2)
    expect(server.rows('products')[0].track_batches).toBe(true)
    await newDevice()
    await engine.runSync(server, sctx)
    expect((await db.products.get(id))!.trackExpiry).toBe(true)
    const r = (await bx.loadExpiry(mgr)).rows
    expect(r.map((x) => [x.status, x.quantity])).toEqual([['expired', 7], ['soon', 10]])
  })
})
