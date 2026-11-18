import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { PaymentError } from '../domain/payments'
import { buildSale, type CartLine } from '../domain/pos'
import { emptyCostState } from '../domain/costing'
import { MAX_COLLECTION, checkRequest, fitsSale, isUsable, unusedCollections, type CollectionRecord } from '../domain/tillCollections'

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

const owner: import('./repo').Ctx = { tenantId: 't1', shopId: 's1', userId: 'o', role: 'owner', oversellPolicy: 'allow_and_flag' }
const sctx = { tenantId: 't1', deviceName: 'Phone' }
let server: InstanceType<typeof FakeServer>
const NOW = new Date()

const coll = (over: Partial<CollectionRecord> = {}): CollectionRecord => ({
  id: newId(), tenantId: 't1', shopId: 's1', provider: 'mtn_momo', phone: '+237677123456', amount: 5_000, status: 'successful',
  providerReference: 'FT-1', createdAt: NOW.toISOString(), ...over,
})

beforeEach(async () => {
  server = new FakeServer()
  await Promise.all(db.tables.map((t) => t.clear()))
  store.set('stockcm.deviceId', newId())
})

async function setup() {
  const pid = await repo.addProduct(owner, { name: 'Riz', baseUnit: 'sac', minStock: 0, taxRateBp: 0, isService: false, units: [{ name: 'sac', factor: 1, sellPrice: 10_000, isBase: true }], openingQty: 50, openingTotalCost: 300_000 })
  const unit = (await db.units.where('productId').equals(pid).first())!
  const lines: CartLine[] = [{ productId: pid, productName: 'Riz', unitId: unit.id, unitName: 'sac', factor: 1, unitPrice: 10_000, quantity: 1, lineDiscount: 0, taxRateBp: 0, isService: false }]
  return { lines }
}

describe('the rules', () => {
  it('a request needs a sensible amount and a Cameroon mobile number', () => {
    expect(checkRequest(5_000, '+237677123456')).toBeNull()
    expect(checkRequest(50, '+237677123456')).toBe('amount')
    expect(checkRequest(MAX_COLLECTION + 1, '+237677123456')).toBe('amount')
    expect(checkRequest(1.5, '+237677123456')).toBe('amount')
    expect(checkRequest(5_000, '677123456')).toBe('phone')
  })
  it('only money really received, unused, from this shop, and not ancient, can be used', () => {
    const ctx = { shopId: 's1', now: NOW }
    expect(isUsable(coll(), ctx)).toBe(true)
    expect(isUsable(coll({ status: 'pending' }), ctx)).toBe(false)
    expect(isUsable(coll({ status: 'failed' }), ctx)).toBe(false)
    expect(isUsable(coll({ saleId: 'x' }), ctx)).toBe(false)
    expect(isUsable(coll({ shopId: 's2' }), ctx)).toBe(false)
    expect(isUsable(coll({ createdAt: new Date(NOW.getTime() - 31 * 86_400_000).toISOString() }), ctx)).toBe(false)
  })
  it('lists waiting money oldest first; a fixed amount only fits a sale that needs at least that much', () => {
    const a = coll({ createdAt: '2026-11-17T08:00:00Z' })
    const b = coll({ createdAt: '2026-11-17T07:00:00Z' })
    expect(unusedCollections([a, b, coll({ status: 'failed' })], { shopId: 's1', now: NOW }).map((c) => c.id)).toEqual([b.id, a.id])
    expect(fitsSale(coll({ amount: 5_000 }), 4_999)).toBe('too_big')
    expect(fitsSale(coll({ amount: 5_000 }), 5_000)).toBeNull()
  })
})

describe('the sale builder', () => {
  let n = 0
  const base = (extra: Partial<Parameters<typeof buildSale>[0]> = {}) => ({
    newId: () => `id${++n}`, tenantId: 't', shopId: 's', userId: 'u', deviceId: 'd', role: 'cashier' as const, saleNumber: 'S1', nowIso: '2026-11-18T10:00:00Z',
    lines: [{ productId: 'a', productName: 'A', unitId: 'u', unitName: 'p', factor: 1, unitPrice: 10_000, quantity: 1, lineDiscount: 0, taxRateBp: 0, isService: false }] as CartLine[],
    payments: [{ method: 'mtn_momo' as const, amount: 10_000 }], costStates: { a: { ...emptyCostState, quantity: 10, value: 5000 } }, oversellPolicy: 'allow_and_flag' as const, ...extra,
  })
  it('a confirmed payment becomes its own verified entry; the rest of the method stays recorded', () => {
    const r = buildSale(base({ collections: [{ id: 'c1', method: 'mtn_momo', amount: 6_000, providerReference: 'FT-9' }] }))
    expect(r.transactions.map((t) => [t.reference, t.amount, t.verification, t.collectionId ?? null])).toEqual([
      ['S1-mtn_momo-c1', 6_000, 'provider_verified', 'c1'],
      ['S1-mtn_momo', 4_000, 'recorded', null],
    ])
    expect(r.transactions[0].providerReference).toBe('FT-9')
    expect(r.transactions.reduce((t, x) => t + x.amount, 0)).toBe(r.sale.collected)
  })
  it('a payment covered completely leaves no recorded remainder; cash is untouched', () => {
    const r = buildSale(base({ payments: [{ method: 'mtn_momo', amount: 6_000 }, { method: 'cash', amount: 4_000 }], collections: [{ id: 'c1', method: 'mtn_momo', amount: 6_000, providerReference: 'FT-9' }] }))
    expect(r.transactions.map((t) => [t.method, t.verification])).toEqual([['mtn_momo', 'provider_verified'], ['cash', 'recorded']])
  })
  it('without collections nothing changes: manual mobile money is still only recorded', () => {
    const r = buildSale(base())
    expect(r.transactions).toHaveLength(1)
    expect(r.transactions[0]).toMatchObject({ reference: 'S1-mtn_momo', verification: 'recorded' })
  })
  it('refuses a collection bigger than the sale pays by that method, one on the wrong method, a repeat, or an incomplete one', () => {
    expect(() => buildSale(base({ collections: [{ id: 'c1', method: 'mtn_momo', amount: 10_001, providerReference: 'x' }] }))).toThrow(PaymentError)
    expect(() => buildSale(base({ collections: [{ id: 'c1', method: 'orange_money', amount: 5_000, providerReference: 'x' }] }))).toThrow(PaymentError)
    expect(() => buildSale(base({ collections: [{ id: 'c1', method: 'mtn_momo', amount: 3_000, providerReference: 'x' }, { id: 'c1', method: 'mtn_momo', amount: 3_000, providerReference: 'y' }] }))).toThrow(/twice/)
    expect(() => buildSale(base({ collections: [{ id: 'c1', method: 'mtn_momo', amount: 3_000, providerReference: '' }] }))).toThrow(/incomplete/)
  })
  it('two collections on one method are two verified entries', () => {
    const r = buildSale(base({ collections: [{ id: 'c1', method: 'mtn_momo', amount: 4_000, providerReference: 'a' }, { id: 'c2', method: 'mtn_momo', amount: 6_000, providerReference: 'b' }] }))
    expect(r.transactions.map((t) => t.verification)).toEqual(['provider_verified', 'provider_verified'])
  })
})

describe('at the till', () => {
  it('uses a confirmed collection: verified entry, collection marked used, and it cannot be used again', async () => {
    const { lines } = await setup()
    const c = coll({ amount: 10_000 })
    await db.tillCollections.add(c)
    const r = await repo.checkout(owner, { lines, payments: [{ method: 'mtn_momo', amount: 10_000 }], collectionIds: [c.id] })
    expect(r.transactions[0]).toMatchObject({ verification: 'provider_verified', collectionId: c.id, providerReference: 'FT-1' })
    expect((await db.tillCollections.get(c.id))!.saleId).toBe(r.sale.id)
    await expect(repo.checkout(owner, { lines, payments: [{ method: 'mtn_momo', amount: 10_000 }], collectionIds: [c.id] })).rejects.toThrow(/cannot be used/)
    expect(await db.sales.count()).toBe(1)
  })
  it('refuses a collection that is not confirmed, is from another shop, or is unknown', async () => {
    const { lines } = await setup()
    const pending = coll({ amount: 10_000, status: 'pending' })
    const other = coll({ amount: 10_000, shopId: 's2' })
    await db.tillCollections.bulkAdd([pending, other])
    for (const id of [pending.id, other.id, 'nope']) {
      await expect(repo.checkout(owner, { lines, payments: [{ method: 'mtn_momo', amount: 10_000 }], collectionIds: [id] })).rejects.toThrow(/cannot be used/)
    }
    expect(await db.sales.count()).toBe(0)
  })
  it('a normal manual mobile-money sale is unchanged', async () => {
    const { lines } = await setup()
    const r = await repo.checkout(owner, { lines, payments: [{ method: 'mtn_momo', amount: 10_000 }] })
    expect(r.transactions[0].verification).toBe('recorded')
  })
})

describe('sync', () => {
  it('the sale uploads with its claim; the server accepts a real collection once and refuses a forged or reused one', async () => {
    const { lines } = await setup()
    const c = coll({ amount: 10_000 })
    await db.tillCollections.add(c)
    server.collections.set(c.id, { amount: 10_000, method: 'mtn_momo', providerReference: 'FT-1', status: 'successful' })
    const r = await repo.checkout(owner, { lines, payments: [{ method: 'mtn_momo', amount: 10_000 }], collectionIds: [c.id] })
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).pendingGroups).toBe(0)
    const stored = [...server.tables.financial_transactions.values()].map((v) => v.row).find((t) => t.sale_id === r.sale.id)!
    expect(stored).toMatchObject({ verification: 'provider_verified', provider_reference: 'FT-1', collection_id: c.id })
    expect(server.collections.get(c.id)!.usedBy).toBe(r.sale.id)
  })
  it('a collection the server does not know (a forged claim) stops that sale from uploading, and it stays on the device', async () => {
    const { lines } = await setup()
    const c = coll({ amount: 10_000 })
    await db.tillCollections.add(c) // the server never heard of it
    await repo.checkout(owner, { lines, payments: [{ method: 'mtn_momo', amount: 10_000 }], collectionIds: [c.id] })
    await engine.runSync(server, sctx).catch(() => undefined)
    expect(server.tables.financial_transactions.size).toBe(0)
    expect(server.tables.sales.size).toBe(0)
  })
})
