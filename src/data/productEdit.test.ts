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
const add = (name: string, barcode?: string) => repo.addProduct(mgr, {
  name, barcode, baseUnit: 'piece', minStock: 2, taxRateBp: 0, isService: false,
  units: [{ name: 'piece', factor: 1, sellPrice: 500, isBase: true }], openingQty: 10, openingTotalCost: 5000,
})
const baseUnit = async (id: string) => (await db.units.where('productId').equals(id).filter((u) => u.isBase).first())!

describe('editing a product', () => {
  it('saves only what changed, keeps the old values for the log, and says when nothing changed', async () => {
    const id = await add('Eau', '5449000000996')
    expect(await ed.updateProduct(mgr, id, { name: 'Eau', minStock: 2 })).toBe(false)
    expect(await ed.updateProduct(mgr, id, { name: '  Eau 1.5L ', minStock: 6, taxRateBp: 1925 })).toBe(true)
    const p = (await db.products.get(id))!
    expect([p.name, p.minStock, p.taxRateBp, p.barcode]).toEqual(['Eau 1.5L', 6, 1925, '5449000000996'])
    const row = (await db.outbox.toArray()).find((o) => o.table === 'product_edit')!
    expect(row.payload).toMatchObject({ id, changes: { name: 'Eau 1.5L', minStock: 6, taxRateBp: 1925 }, before: { name: 'Eau', minStock: 2, taxRateBp: 0 } })
  })

  it('a barcode can be changed or cleared, but never duplicated; same for the reference', async () => {
    const a = await add('A', '5449000000996')
    const b = await add('B')
    await expect(ed.updateProduct(mgr, b, { barcode: '5449000000996' })).rejects.toThrow(/already exists/)
    await expect(ed.updateProduct(mgr, b, { barcode: '0036000291452' })).resolves.toBe(true)
    await expect(ed.updateProduct(mgr, a, { barcode: null })).resolves.toBe(true)
    expect((await db.products.get(a))!.barcode).toBeUndefined()
    await expect(ed.updateProduct(mgr, b, { barcode: '5449000000996' })).resolves.toBe(true)
    await ed.updateProduct(mgr, a, { sku: 'EAU-1' })
    await expect(ed.updateProduct(mgr, b, { sku: 'EAU-1' })).rejects.toThrow(/reference already exists/)
  })

  it('hiding a product keeps its stock and history', async () => {
    const id = await add('Vieux')
    await ed.updateProduct(mgr, id, { active: false })
    expect((await db.products.get(id))!.active).toBe(false)
    expect((await db.costs.get(`s1:${id}`))!.quantity).toBe(10)
    await ed.updateProduct(mgr, id, { active: true })
    expect((await db.products.get(id))!.active).toBe(true)
  })

  it('refuses bad values and people without the right', async () => {
    const id = await add('Eau')
    await expect(ed.updateProduct(mgr, id, { name: '  ' })).rejects.toThrow(/invalid/)
    await expect(ed.updateProduct(mgr, id, { taxRateBp: 99999 })).rejects.toThrow(/invalid/)
    await expect(ed.updateProduct({ ...mgr, role: 'cashier' }, id, { name: 'X' })).rejects.toThrow(/not allowed/)
    await expect(ed.updateProduct({ ...mgr, role: 'storekeeper' }, id, { name: 'X' })).rejects.toThrow(/not allowed/)
  })
})

describe('prices and units', () => {
  it('a price change affects new sales only; the old sale keeps the price it was sold at', async () => {
    const id = await add('Eau')
    const u = await baseUnit(id)
    const line = (price: number) => ({ productId: id, productName: 'Eau', unitId: u.id, unitName: 'piece', factor: 1, unitPrice: price, quantity: 1, lineDiscount: 0, taxRateBp: 0, isService: false })
    const first = await repo.checkout(mgr, { lines: [line(u.sellPrice)], payments: [{ method: 'cash', amount: 500 }] })
    await ed.updateUnit(mgr, u.id, { sellPrice: 650 })
    expect((await db.units.get(u.id))!.sellPrice).toBe(650)
    expect((await db.saleLines.where('saleId').equals(first.sale.id).first())!.unitPrice).toBe(500)
  })

  it('refuses negative or fractional prices and a clashing unit name; factors cannot be edited', async () => {
    const id = await add('Eau')
    const u = await baseUnit(id)
    const carton = await ed.addUnit(mgr, id, { name: 'carton', factor: 24, sellPrice: 11000 })
    await expect(ed.updateUnit(mgr, u.id, { sellPrice: -1 })).rejects.toThrow(/invalid/)
    await expect(ed.updateUnit(mgr, u.id, { sellPrice: 10.5 })).rejects.toThrow(/invalid/)
    await expect(ed.updateUnit(mgr, carton.id, { name: 'PIECE' })).rejects.toThrow(/already has a unit/)
    await expect(ed.updateUnit(mgr, carton.id, { name: 'caisse', factor: 12 } as never)).resolves.toBe(true)
    expect((await db.units.get(carton.id))!.factor).toBe(24)
    await expect(ed.addUnit(mgr, id, { name: 'demi', factor: 1, sellPrice: 1 })).rejects.toThrow(/invalid/)
  })
})

describe('edits and sync', () => {
  it('reach the server and a second device, which sees the same prices and barcode', async () => {
    const id = await add('Eau', '5449000000996')
    await engine.runSync(server, sctx)
    const u = await baseUnit(id)
    await ed.updateProduct(mgr, id, { name: 'Eau 1.5L', barcode: null })
    await ed.updateUnit(mgr, u.id, { sellPrice: 650 })
    await ed.addUnit(mgr, id, { name: 'carton', factor: 24, sellPrice: 15000 })
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).pendingGroups).toBe(0)
    await newDevice()
    await engine.runSync(server, sctx)
    const p = (await db.products.get(id))!
    expect([p.name, p.barcode]).toEqual(['Eau 1.5L', undefined])
    expect((await db.units.where('productId').equals(id).toArray()).map((x) => [x.name, x.sellPrice]).sort()).toEqual([['carton', 15000], ['piece', 650]])
  })

  it('a download does not overwrite an edit that has not been uploaded yet', async () => {
    const id = await add('Eau')
    await engine.runSync(server, sctx)
    await ed.updateProduct(mgr, id, { name: 'Mon nom' })
    const row = server.tables.products.get(id)!
    server.tables.products.set(id, { row: { ...row.row, name: 'Nom du voisin' }, changed: row.changed + 1000 })
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).pendingGroups).toBe(0)
    expect((await db.products.get(id))!.name).toBe('Mon nom')
  })

  it('an edit whose barcode clashes elsewhere is flagged, and discarding it restores the old values', async () => {
    const a = await add('A')
    const b = await add('B', '5449000000996')
    await engine.runSync(server, sctx)
    const rowA = server.tables.products.get(a)!
    server.tables.products.set(a, { row: { ...rowA.row, barcode: '0036000291452' }, changed: rowA.changed + 1 })
    await ed.updateProduct(mgr, b, { barcode: '0036000291452' })
    await engine.runSync(server, sctx)
    const s = await getSyncSummary()
    expect(s.conflictGroups + s.rejectedGroups).toBe(1)
    const group = (await db.outbox.filter((o) => o.status !== 'pending').first())!.groupId
    await engine.resolveBarcodeConflict(group)
    expect(await db.outbox.count()).toBe(0)
    expect((await db.products.get(b))!.barcode).toBe('5449000000996')
  })
})
