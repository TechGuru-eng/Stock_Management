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
  name, barcode, baseUnit: 'piece', minStock: 0, taxRateBp: 0, isService: false,
  units: [{ name: 'piece', factor: 1, sellPrice: 100, isBase: true }], openingQty: 0, openingTotalCost: 0,
})

describe('giving a barcode to a product that has none', () => {
  it('fills only an empty barcode, refuses a code in use, and needs the right to edit products', async () => {
    const a = await add('Sans code')
    const b = await add('Avec code', '5449000000996')
    expect(await repo.assignBarcode(mgr, a, ' 2000000000008 ')).toBe('2000000000008')
    expect((await db.products.get(a))!.barcode).toBe('2000000000008')
    await expect(repo.assignBarcode(mgr, a, '2000000000015')).rejects.toThrow(/already has a barcode/) // never overwritten
    const c = await add('Autre')
    await expect(repo.assignBarcode(mgr, c, '2000000000008')).rejects.toThrow(/already exists/)
    await expect(repo.assignBarcode(mgr, c, '  ')).rejects.toThrow(/empty/)
    await expect(repo.assignBarcode({ ...mgr, role: 'cashier' }, c, '2000000000022')).rejects.toThrow(/not allowed/)
    void b
  })

  it('reaches the server and a second device', async () => {
    const a = await add('Sans code')
    await engine.runSync(server, sctx)
    await repo.assignBarcode(mgr, a, '2000000000008')
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).pendingGroups).toBe(0)
    expect(server.rows('products')[0].barcode).toBe('2000000000008')
    await newDevice()
    await engine.runSync(server, sctx)
    expect((await db.products.get(a))!.barcode).toBe('2000000000008')
  })

  it('two devices giving the same code to different products: one is flagged and can be dropped without losing anything else', async () => {
    const a = await add('Produit A')
    const b = await add('Produit B')
    await engine.runSync(server, sctx)
    await repo.assignBarcode(mgr, a, '2000000000008')
    await engine.runSync(server, sctx)
    // a second phone that never saw that assignment gives the same code to B
    await newDevice()
    await engine.runSync(server, sctx)
    await db.products.update(b, { barcode: undefined })
    // simulate it not having pulled A's barcode yet
    await db.products.update(a, { barcode: undefined })
    await repo.assignBarcode(mgr, b, '2000000000008')
    await engine.runSync(server, sctx)
    const s = await getSyncSummary()
    expect(s.conflictGroups).toBe(1)
    const group = (await db.outbox.filter((o) => o.status === 'conflict').first())!.groupId
    await engine.resolveBarcodeConflict(group)
    expect(await db.outbox.count()).toBe(0)
    expect((await db.products.get(b))!.barcode).toBeUndefined()
  })
})
