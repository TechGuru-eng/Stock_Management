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
const { transferStock } = await import('./shopsRepo')
const { rebuildCost } = await import('./projection')
const engine = await import('../sync/engine')
const { FakeServer } = await import('../sync/testing/fakeServer')
const { getSyncSummary } = await import('../sync/status')

const A: import('./repo').Ctx = { tenantId: 't1', shopId: 'shopA', userId: 'u1', role: 'owner', oversellPolicy: 'allow_and_flag' }
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

async function water() {
  return repo.addProduct(A, {
    name: 'Eau', baseUnit: 'bottle', minStock: 0, taxRateBp: 0, isService: false,
    units: [{ name: 'bottle', factor: 1, sellPrice: 500, isBase: true }], openingQty: 48, openingTotalCost: 24000,
  })
}
const qtyAt = async (shop: string, p: string) => (await db.costs.get(`${shop}:${p}`))?.quantity ?? 0
const valueAt = async (shop: string, p: string) => (await db.costs.get(`${shop}:${p}`))?.value ?? 0

describe('transferring stock between shops', () => {
  it('moves quantity and value, nothing appears or disappears', async () => {
    const p = await water()
    await transferStock(A, 'shopB', [{ productId: p, qty: 12 }], 'restock annex')
    expect(await qtyAt('shopA', p)).toBe(36)
    expect(await qtyAt('shopB', p)).toBe(12)
    expect(await valueAt('shopA', p)).toBe(18000)
    expect(await valueAt('shopB', p)).toBe(6000) // same average cost, 500 each
    expect((await valueAt('shopA', p)) + (await valueAt('shopB', p))).toBe(24000)
  })

  it('refuses more than is in stock and leaves everything untouched', async () => {
    const p = await water()
    const before = await db.movements.count()
    await expect(transferStock(A, 'shopB', [{ productId: p, qty: 49 }])).rejects.toThrow(/not_enough_stock/)
    await expect(transferStock(A, 'shopA', [{ productId: p, qty: 1 }])).rejects.toThrow(/same_shop/)
    expect(await db.movements.count()).toBe(before)
    expect(await qtyAt('shopA', p)).toBe(48)
  })

  it('is not for cashiers', async () => {
    const p = await water()
    await expect(transferStock({ ...A, role: 'cashier' }, 'shopB', [{ productId: p, qty: 1 }])).rejects.toThrow(/not allowed/)
  })

  it('goes to the server as one group, and a second device rebuilds the same stock in both shops', async () => {
    const p = await water()
    await transferStock(A, 'shopB', [{ productId: p, qty: 20 }])
    const groups = new Set((await db.outbox.toArray()).filter((o) => o.table === 'stock_movements' && (o.payload as { type: string }).type.startsWith('transfer')).map((o) => o.groupId))
    expect(groups.size).toBe(1) // out and in together: all or nothing
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).pendingGroups).toBe(0)

    await newDevice()
    await engine.runSync(server, sctx)
    expect((await rebuildCost('shopA', p)).quantity).toBe(28)
    expect((await rebuildCost('shopB', p)).quantity).toBe(20)
    expect((await rebuildCost('shopB', p)).value).toBe(10000)
  })

  it('the server refuses a transfer that does not balance', async () => {
    const p = await water()
    await transferStock(A, 'shopB', [{ productId: p, qty: 5 }])
    const inRow = (await db.outbox.toArray()).find((o) => (o.payload as { type: string }).type === 'transfer_in')!
    await db.outbox.update(inRow.seq!, { payload: { ...(inRow.payload as object), quantity: 6 } }) // tampered
    await engine.runSync(server, sctx)
    const s = await getSyncSummary()
    expect(s.rejectedGroups).toBe(1)
    expect(server.rows('stock_movements').filter((m) => String(m.movement_type).startsWith('transfer'))).toHaveLength(0)
  })
})

describe('barcodes on products', () => {
  const add = (barcode: string, name: string) => repo.addProduct(A, {
    name, barcode, baseUnit: 'piece', minStock: 0, taxRateBp: 0, isService: false,
    units: [{ name: 'piece', factor: 1, sellPrice: 100, isBase: true }], openingQty: 0, openingTotalCost: 0,
  })
  it('stores a scanned code cleanly and refuses the same code again, even spelled as UPC-A / EAN-13', async () => {
    const id = await add(' 036000291452\r\n', 'Soda')
    expect((await db.products.get(id))!.barcode).toBe('036000291452')
    await expect(add('0036000291452', 'Soda again')).rejects.toThrow(/barcode already exists/)
    await expect(add('036000291452', 'Soda again')).rejects.toThrow(/barcode already exists/)
    await expect(add('5449000000996', 'Cola')).resolves.toBeTruthy()
  })
})
