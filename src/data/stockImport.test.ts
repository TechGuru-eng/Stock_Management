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
const imp = await import('./importRepo')
const { parseCsv } = await import('../domain/csvParse')
const { planStockImport } = await import('../domain/stockImport')
const engine = await import('../sync/engine')
const { FakeServer } = await import('../sync/testing/fakeServer')
const { getSyncSummary } = await import('../sync/status')
const { rebuildCost } = await import('./projection')

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

const catalogue = (name: string, unitPrice = 500) => repo.addProduct(mgr, {
  name, baseUnit: 'piece', minStock: 0, taxRateBp: 0, isService: false,
  units: [{ name: 'piece', factor: 1, sellPrice: unitPrice, isBase: true }, { name: 'carton', factor: 24, sellPrice: unitPrice * 22, isBase: false }], openingQty: 0, openingTotalCost: 0,
})
const run = async (csv: string, createMissing = false, includeFlagged = false, ctx = mgr) => {
  const plan = planStockImport(parseCsv(csv), await imp.loadKnownProducts(ctx.shopId), { createMissing })
  return { plan, res: await imp.applyStockImport(ctx, plan, { includeFlagged }) }
}
const qty = async (p: string, shop = 's1') => (await db.costs.get(`${shop}:${p}`))?.quantity ?? 0
const worth = async (p: string) => (await db.costs.get(`s1:${p}`))?.value ?? 0

describe('importing opening stock', () => {
  it('records the quantity and its value for products that never had stock, and adds new products with theirs', async () => {
    const water = await catalogue('Eau')
    const { res } = await run('name;unit;qty;unit_cost;price\nEau;carton;3;7 200;\nHuile;;12;1 200;1 800', true)
    expect(res).toMatchObject({ recorded: 1, created: 1, failed: [], value: 21600 + 14400 })
    expect([await qty(water), await worth(water)]).toEqual([72, 21600])
    const oil = (await db.products.filter((p) => p.name === 'Huile').first())!
    expect([await qty(oil.id), await worth(oil.id)]).toEqual([12, 14400])
    expect((await db.movements.filter((m) => m.type === 'opening').toArray()).length).toBe(2)
  })

  it('a second import of the same file cannot double the stock', async () => {
    const water = await catalogue('Eau')
    const csv = 'name;qty;total_cost\nEau;10;3000'
    await run(csv)
    const again = await run(csv)
    expect(again.plan.rows[0]).toMatchObject({ kind: 'error', problem: 'already_has_stock' })
    expect(again.res.recorded).toBe(0)
    expect(await qty(water)).toBe(10)
  })

  it('a plan that went stale is refused at the moment of recording', async () => {
    const water = await catalogue('Eau')
    const plan = planStockImport(parseCsv('name;qty;total_cost\nEau;10;3000'), await imp.loadKnownProducts('s1'), { createMissing: false })
    await repo.postOpeningStock(mgr, water, 5, 1500) // someone records stock meanwhile
    const res = await imp.applyStockImport(mgr, plan, { includeFlagged: false })
    expect(res.recorded).toBe(0)
    expect(res.failed[0].message).toMatch(/already has stock history/)
    expect(await qty(water)).toBe(5)
  })

  it('stock is per shop: another shop can have its own opening stock for the same product', async () => {
    const water = await catalogue('Eau')
    await run('name;qty;total_cost\nEau;10;3000')
    const shop2 = { ...mgr, shopId: 's2' }
    const { res } = await run('name;qty;total_cost\nEau;4;1200', false, false, shop2)
    expect(res.recorded).toBe(1)
    expect([await qty(water, 's1'), await qty(water, 's2')]).toEqual([10, 4])
  })

  it('a cost above the selling price waits for an explicit yes', async () => {
    const water = await catalogue('Eau', 500)
    const csv = 'name;qty;unit_cost\nEau;10;900'
    expect((await run(csv)).res).toMatchObject({ recorded: 0, skipped: 1 })
    expect(await qty(water)).toBe(0)
    expect((await run(csv, false, true)).res.recorded).toBe(1)
    expect(await qty(water)).toBe(10)
  })

  it('needs the right to receive stock and edit products', async () => {
    await catalogue('Eau')
    const plan = planStockImport(parseCsv('name;qty;total_cost\nEau;1;1'), await imp.loadKnownProducts('s1'), { createMissing: false })
    await expect(imp.applyStockImport({ ...mgr, role: 'cashier' }, plan, { includeFlagged: false })).rejects.toThrow(/not allowed/)
    await expect(imp.applyStockImport({ ...mgr, role: 'storekeeper' }, plan, { includeFlagged: false })).rejects.toThrow(/not allowed/)
  })

  it('reaches the server and a second device, which rebuilds the same stock and value', async () => {
    const water = await catalogue('Eau')
    await engine.runSync(server, sctx)
    await run('name;qty;unit_cost;price\nEau;48;300;\nRiz;10;600;800', true)
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).pendingGroups).toBe(0)
    await newDevice()
    await engine.runSync(server, sctx)
    const s = await rebuildCost('s1', water)
    expect([s.quantity, s.value]).toEqual([48, 14400])
    const rice = (await db.products.filter((p) => p.name === 'Riz').first())!
    expect((await rebuildCost('s1', rice.id)).quantity).toBe(10)
  })
})
