import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
}

const DAY = 86_400_000
const { generateLicenceKeys, buildPayload, signLicence } = await import('../domain/licence')
const keys = await generateLicenceKeys()
const other = await generateLicenceKeys()
vi.stubEnv('VITE_LICENCE_PUBLIC_KEY', JSON.stringify(keys.publicJwk))

await import('../i18n')
const { db } = await import('../data/db')
const repo = await import('../data/repo')
const { installWriteGuard, getReadOnlyReason, WriteBlockedError, setReadOnly } = await import('../data/writeGuard')
const lic = await import('./licenceStore')
const { cancelSale } = await import('../data/returnsRepo')

installWriteGuard()

const ctx: import('../data/repo').Ctx = { tenantId: 't1', shopId: 's1', userId: 'u1', role: 'owner', oversellPolicy: 'allow_and_flag' }
const t0 = Date.parse('2026-11-17T12:00:00Z')

async function giveLicence(opts: { periodEndMs: number; nowMs?: number; products?: number | null; base?: 'trial' | 'active' | 'suspended'; key?: typeof keys }) {
  const payload = buildPayload({
    tenantId: 't1', plan: 'business', limits: { shops: 1, staff: 5, products: opts.products === undefined ? 5000 : opts.products },
    base: opts.base ?? 'active', periodEndMs: opts.periodEndMs, graceDays: 7, offlineDays: 30, nowMs: opts.nowMs ?? t0,
  })
  await db.meta.put({ key: 'licence', value: await signLicence(payload, (opts.key ?? keys).privateJwk) })
}

const water = (name = 'Eau') => ({
  name, baseUnit: 'bottle', minStock: 0, taxRateBp: 0, isService: false,
  units: [{ name: 'bottle', factor: 1, sellPrice: 500, isBase: true }], openingQty: 10, openingTotalCost: 5000,
})

beforeEach(async () => {
  setReadOnly(null)
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('licence handling on the device', () => {
  it('no licence yet (a fresh install) does not block anyone', async () => {
    expect(await lic.applyGuard(t0)).toBeNull()
    expect(getReadOnlyReason()).toBeNull()
    await expect(repo.addProduct(ctx, water())).resolves.toBeTruthy()
  })

  it('a licence signed with the wrong key is ignored', async () => {
    await giveLicence({ periodEndMs: t0 + 10 * DAY, key: other })
    expect(await lic.loadLicence()).toBeNull()
  })

  it('a paid-up business works normally', async () => {
    await giveLicence({ periodEndMs: t0 + 10 * DAY })
    expect((await lic.applyGuard(t0 + DAY))!.status).toBe('valid')
    expect(getReadOnlyReason()).toBeNull()
    await expect(repo.addProduct(ctx, water())).resolves.toBeTruthy()
  })

  it('in the grace period everything still works', async () => {
    await giveLicence({ periodEndMs: t0 - DAY })
    expect((await lic.applyGuard(t0))!.status).toBe('grace')
    await expect(repo.addProduct(ctx, water())).resolves.toBeTruthy()
  })

  it('after grace it is read-only with no connection: new records are refused, existing ones stay readable (test 15)', async () => {
    await giveLicence({ periodEndMs: t0 + 10 * DAY })
    await repo.addProduct(ctx, water('Riz')) // recorded while paid up
    const later = t0 + 20 * DAY // 3 days past the end of grace
    expect((await lic.applyGuard(later))!.status).toBe('expired')
    expect(getReadOnlyReason()).toBe('expired')

    await expect(repo.addProduct(ctx, water('Huile'))).rejects.toBeInstanceOf(WriteBlockedError)
    await expect(repo.addCustomer(ctx, 'Mme Tchoua', undefined, 0)).rejects.toThrow(/lecture seule|read-only/i)
    expect(await db.products.count()).toBe(1) // nothing new, nothing lost
    expect((await db.products.toArray())[0].name).toBe('Riz') // and it can still be read
  })

  it('renewing (a new licence arrives) lifts read-only straight away', async () => {
    await giveLicence({ periodEndMs: t0 - 20 * DAY })
    await lic.applyGuard(t0)
    await expect(repo.addProduct(ctx, water())).rejects.toBeInstanceOf(WriteBlockedError)
    await giveLicence({ periodEndMs: t0 + 30 * DAY })
    await lic.applyGuard(t0)
    await expect(repo.addProduct(ctx, water())).resolves.toBeTruthy()
  })

  it('records downloaded from the server are still stored while read-only', async () => {
    await giveLicence({ periodEndMs: t0 - 20 * DAY })
    await lic.applyGuard(t0)
    const { whilePulling } = await import('../data/writeGuard')
    await whilePulling(() => db.customers.add({ id: 'c-from-server', tenantId: 't1', name: 'From server', creditLimit: 0, createdAt: new Date(t0).toISOString() }))
    expect(await db.customers.count()).toBe(1)
  })

  it('a device that has not synced for 30 days must connect, even though it is paid up', async () => {
    await giveLicence({ periodEndMs: t0 + 365 * DAY })
    const v = await lic.applyGuard(t0 + 31 * DAY)
    expect(v!.status).toBe('sync_required')
    expect(getReadOnlyReason()).toBe('sync_required')
    await expect(repo.addProduct(ctx, water())).rejects.toBeInstanceOf(WriteBlockedError)
  })

  it('setting the device clock back is noticed', async () => {
    await giveLicence({ periodEndMs: t0 + 40 * DAY })
    await lic.applyGuard(t0 + 10 * DAY) // the device sees day 10
    expect((await lic.applyGuard(t0 + 2 * DAY))!.status).toBe('clock_changed') // then someone sets the clock to day 2
    expect(getReadOnlyReason()).toBe('clock_changed')
    expect((await lic.applyGuard(t0 + 10 * DAY + 60_000))!.status).toBe('valid') // back to real time: fine again
  })

  it('a suspended business is read-only', async () => {
    await giveLicence({ periodEndMs: t0 + 40 * DAY, base: 'suspended' })
    expect((await lic.applyGuard(t0))!.status).toBe('suspended')
    await expect(repo.addProduct(ctx, water())).rejects.toBeInstanceOf(WriteBlockedError)
  })

  it('closing the till can always be done, so a day is never left hanging', async () => {
    const { openCashSession, closeCashSession } = await import('../data/financeRepo')
    const s = await openCashSession(ctx, 1000)
    await giveLicence({ periodEndMs: t0 - 20 * DAY })
    await lic.applyGuard(t0)
    await expect(closeCashSession(ctx, s.id, 1000)).resolves.toBeTruthy()
    void cancelSale
  })
})

describe('plan limits on the device', () => {
  it('refuses the product that would exceed the plan, with a clear message', async () => {
    await giveLicence({ periodEndMs: t0 + 10 * DAY, products: 2 })
    await repo.addProduct(ctx, water('A'))
    await repo.addProduct(ctx, water('B'))
    await expect(repo.addProduct(ctx, water('C'))).rejects.toThrow('plan limit reached')
    expect(await db.products.count()).toBe(2)
  })
  it('unlimited plans never block', async () => {
    await giveLicence({ periodEndMs: t0 + 10 * DAY, products: null })
    for (let i = 0; i < 4; i++) await repo.addProduct(ctx, water(`P${i}`))
    expect(await db.products.count()).toBe(4)
  })
})
