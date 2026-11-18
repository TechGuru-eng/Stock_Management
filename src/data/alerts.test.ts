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
const al = await import('./alertsRepo')

const mgr: import('./repo').Ctx = { tenantId: 't1', shopId: 's1', userId: 'm', role: 'manager', oversellPolicy: 'allow_and_flag' }

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  store.set('stockcm.deviceId', newId())
})

async function shop() {
  const water = await repo.addProduct(mgr, { name: 'Eau', baseUnit: 'bouteille', minStock: 6, taxRateBp: 0, isService: false, units: [{ name: 'bouteille', factor: 1, sellPrice: 500, isBase: true }], openingQty: 40, openingTotalCost: 12000 })
  const rice = await repo.addProduct(mgr, { name: 'Riz', baseUnit: 'kg', minStock: 0, taxRateBp: 0, isService: false, units: [{ name: 'kg', factor: 1, sellPrice: 800, isBase: true }], openingQty: 100, openingTotalCost: 60000 })
  const sell = async (p: string, qty: number) => {
    const u = (await db.units.where('productId').equals(p).first())!
    await repo.checkout(mgr, { lines: [{ productId: p, productName: 'x', unitId: u.id, unitName: u.name, factor: 1, unitPrice: u.sellPrice, quantity: qty, lineDiscount: 0, taxRateBp: 0, isService: false }], payments: [{ method: 'cash', amount: qty * u.sellPrice }] })
  }
  return { water, rice, sell }
}

describe('alerts from real records', () => {
  it('raise as sales bring stock down, and go quiet when stock is replenished', async () => {
    const { water, sell } = await shop()
    expect((await al.loadActiveAlerts(mgr)).active).toEqual([])
    await sell(water, 30) // 10 left, 1/day = 10 days: fine; above the minimum of 6
    expect((await al.loadActiveAlerts(mgr)).active).toEqual([])
    await sell(water, 5) // 5 left: at or below the minimum
    const a = (await al.loadActiveAlerts(mgr)).active
    expect(a.map((x) => [x.productId, x.level])).toEqual([[water, 'low']])
    await sell(water, 5)
    expect((await al.loadActiveAlerts(mgr)).active[0].level).toBe('out')
    await repo.receiveStock(mgr, water, (await db.units.where('productId').equals(water).first())!, 48, 14400)
    expect((await al.loadActiveAlerts(mgr)).active).toEqual([])
  })

  it('an order placed covers the alert; snoozing hides it until the time is up', async () => {
    const { water, sell } = await shop()
    await sell(water, 36)
    expect((await al.loadActiveAlerts(mgr)).active).toHaveLength(1)
    await al.snoozeProduct(water, 3)
    expect((await al.loadActiveAlerts(mgr)).active).toEqual([])
    expect((await al.loadActiveAlerts(mgr, new Date(Date.now() + 4 * 86_400_000))).active).toHaveLength(1) // snooze over
    await al.unsnoozeProduct(water)
    expect((await al.loadActiveAlerts(mgr)).active).toHaveLength(1)
    const sup = await pur.addSupplier(mgr, 'Grossiste')
    const u = (await db.units.where('productId').equals(water).first())!
    await pur.createPurchase(mgr, { supplierId: sup.id, lines: [{ productId: water, unitId: u.id, quantity: 48, totalCost: 14400 }] })
    const r = await al.loadActiveAlerts(mgr)
    expect(r.all[0].covered).toBe(true)
    expect(r.active).toEqual([])
  })

  it('is per shop', async () => {
    const { water, sell } = await shop()
    await sell(water, 36)
    expect((await al.loadActiveAlerts({ ...mgr, shopId: 's2' })).active.map((x) => x.level)).toEqual(['out']) // nothing there: only the minimum asks for it
    expect((await al.loadActiveAlerts(mgr)).active).toHaveLength(1)
  })
})

describe('telling the person once', () => {
  it('a new alert is returned once; the same one is not returned again; getting worse is', async () => {
    const { water, sell } = await shop()
    await sell(water, 36)
    const first = (await al.loadActiveAlerts(mgr)).active
    expect((await al.takeNewAlerts(mgr, first)).map((x) => x.productId)).toEqual([water])
    expect(await al.takeNewAlerts(mgr, first)).toEqual([])
    await sell(water, 4)
    const worse = (await al.loadActiveAlerts(mgr)).active
    expect(worse[0].level).toBe('out')
    expect((await al.takeNewAlerts(mgr, worse)).map((x) => x.level)).toEqual(['out'])
    expect(await al.takeNewAlerts(mgr, worse)).toEqual([])
  })
  it('each shop remembers separately', async () => {
    const { water, sell } = await shop()
    await sell(water, 36)
    const a = (await al.loadActiveAlerts(mgr)).active
    await al.takeNewAlerts(mgr, a)
    expect(await al.takeNewAlerts({ ...mgr, shopId: 's2' }, a)).toHaveLength(1)
  })
})

describe('settings', () => {
  it('have defaults, are saved, and are kept within sensible limits', async () => {
    expect(await al.loadAlertSettings()).toEqual({ leadDays: 7, notify: false })
    await al.saveAlertSettings({ notify: true, leadDays: 14 })
    expect(await al.loadAlertSettings()).toEqual({ leadDays: 14, notify: true })
    await al.saveAlertSettings({ leadDays: 9999 })
    expect((await al.loadAlertSettings()).leadDays).toBe(60)
    await al.saveAlertSettings({ leadDays: 0 })
    expect((await al.loadAlertSettings()).leadDays).toBe(1)
  })
})
