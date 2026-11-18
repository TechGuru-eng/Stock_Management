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
const ed = await import('./productsRepo')
const { parseCsv } = await import('../domain/csvParse')
const { planImport } = await import('../domain/priceImport')
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

async function seed() {
  const water = await repo.addProduct(mgr, {
    name: 'Eau 1.5L', barcode: '5449000000996', baseUnit: 'bouteille', minStock: 6, taxRateBp: 0, isService: false,
    units: [{ name: 'bouteille', factor: 1, sellPrice: 500, isBase: true }, { name: 'carton', factor: 24, sellPrice: 11000, isBase: false }], openingQty: 48, openingTotalCost: 14400,
  })
  const rice = await repo.addProduct(mgr, {
    name: 'Riz', baseUnit: 'kg', minStock: 0, taxRateBp: 0, isService: false, units: [{ name: 'kg', factor: 1, sellPrice: 800, isBase: true }], openingQty: 10, openingTotalCost: 6000,
  })
  return { water, rice }
}
const run = async (csv: string, createMissing: boolean, includeFlagged = false) => {
  const plan = planImport(parseCsv(csv), await imp.loadKnownProducts(), { createMissing })
  return { plan, res: await imp.applyImport(mgr, plan, { includeFlagged }) }
}

describe('applying an import', () => {
  it('updates prices per unit, adds new products, and leaves stock alone', async () => {
    const { water, rice } = await seed()
    const { res } = await run('name;unit;price\nEau 1.5L;bouteille;550\nEau 1.5L;carton;12 000\nHuile 1L;litre;1 800', true)
    expect(res).toMatchObject({ updated: 2, created: 1, skipped: 0, failed: [] })
    const prices = (await db.units.toArray()).map((u) => [u.name, u.sellPrice]).sort()
    expect(prices).toEqual([['bouteille', 550], ['carton', 12000], ['kg', 800], ['litre', 1800]])
    expect((await db.costs.get(`s1:${water}`))!.quantity).toBe(48)
    expect((await db.costs.get(`s1:${rice}`))!.quantity).toBe(10)
    const oil = (await db.products.filter((p) => p.name === 'Huile 1L').first())!
    expect(oil.baseUnit).toBe('litre')
  })

  it('a big price jump waits for an explicit yes', async () => {
    await seed()
    const csv = 'name;price\nEau 1.5L;5000\nRiz;850'
    const first = await run(csv, false)
    expect(first.res).toMatchObject({ updated: 1, skipped: 1 })
    expect((await db.units.filter((u) => u.name === 'bouteille').first())!.sellPrice).toBe(500)
    const second = await run(csv, false, true)
    expect(second.res.updated).toBe(1) // Riz is now unchanged, the flagged one goes through
    expect((await db.units.filter((u) => u.name === 'bouteille').first())!.sellPrice).toBe(5000)
  })

  it('one bad row never blocks the others, and is reported with its line', async () => {
    await seed()
    const plan = planImport(parseCsv('name;barcode;price\nRiz;;900\nNeuf;5449000000996;10'), await imp.loadKnownProducts(), { createMissing: true })
    // the second row matched Eau by barcode; force a failure by making the product unknown to the repo afterwards
    const bad = { ...plan, rows: [...plan.rows, { line: 9, kind: 'update' as const, productId: 'ghost', unitId: null, name: 'Fantôme', unitName: 'x', changes: [{ field: 'minStock' as const, from: 0, to: 3 }], flagged: false }] }
    const res = await imp.applyImport(mgr, bad, { includeFlagged: true })
    expect(res.updated).toBe(2)
    expect(res.failed).toEqual([{ line: 9, name: 'Fantôme', message: 'product not found' }])
  })

  it('needs the right to edit products', async () => {
    await seed()
    const plan = planImport(parseCsv('name;price\nRiz;900'), await imp.loadKnownProducts(), { createMissing: false })
    await expect(imp.applyImport({ ...mgr, role: 'cashier' }, plan, { includeFlagged: false })).rejects.toThrow(/not allowed/)
  })

  it('goes to the server and a second device sees the new prices and products', async () => {
    await seed()
    await engine.runSync(server, sctx)
    await run('name;price;unit\nRiz;900;\nSavon;250;piece', true)
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).pendingGroups).toBe(0)
    await newDevice()
    await engine.runSync(server, sctx)
    expect((await db.units.toArray()).map((u) => [u.name, u.sellPrice]).sort()).toEqual([['bouteille', 500], ['carton', 11000], ['kg', 900], ['piece', 250]])
  })
})

describe('exporting the catalogue to edit in a spreadsheet', () => {
  it('writes one line per unit and can be imported straight back with no changes', async () => {
    const { rice } = await seed()
    await ed.updateProduct(mgr, rice, { taxRateBp: 1925 })
    const csv = await imp.exportCatalogueCsv(';')
    expect(csv.startsWith('﻿name;barcode;sku;unit;price;min_stock;tax_percent')).toBe(true)
    expect(csv).toContain('Eau 1.5L;5449000000996;;carton;11000;;')
    expect(csv).toContain('Riz;;;kg;800;0;19.25')
    const plan = planImport(parseCsv(csv), await imp.loadKnownProducts(), { createMissing: false })
    expect(plan.counts).toMatchObject({ update: 0, error: 0, unchanged: 3 })
  })

  it('hidden products are not exported', async () => {
    const { rice } = await seed()
    await ed.updateProduct(mgr, rice, { active: false })
    expect(await imp.exportCatalogueCsv(',')).not.toContain('Riz')
  })
})
