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
Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })

const { db, newId } = await import('../data/db')
const repo = await import('../data/repo')
const { setOutboxActor } = await import('../data/actor')
const engine = await import('./engine')
const { FakeServer } = await import('./testing/fakeServer')
const { getSyncSummary } = await import('./status')
const { enrollLocalPin, verifyLocalPin, hasLocalPin } = await import('../auth/localPin')
const { rememberPerson, loadRoster, pruneRoster } = await import('../auth/roster')

const sctx = { tenantId: 't1', deviceName: 'Till' }
const ctxFor = (userId: string, role: 'cashier' | 'manager' = 'cashier') => ({ tenantId: 't1', shopId: 's1', userId, role, oversellPolicy: 'allow_and_flag' as const })
let server: InstanceType<typeof FakeServer>

beforeEach(async () => {
  server = new FakeServer()
  await Promise.all(db.tables.map((t) => t.clear()))
  store.set('stockcm.deviceId', newId())
  setOutboxActor(null)
})

describe('several people at one till, offline', () => {
  it('records are credited to whoever was at the till, even after switching without internet', async () => {
    setOutboxActor('awa')
    await repo.addCustomer(ctxFor('awa'), 'Client 1', undefined, 0)
    setOutboxActor('paul') // switched with a PIN, still no internet
    await repo.addCustomer(ctxFor('paul', 'manager'), 'Client 2', undefined, 0)
    setOutboxActor('awa')
    await repo.addCustomer(ctxFor('awa'), 'Client 3', undefined, 0)

    const rows = await db.outbox.orderBy('seq').toArray()
    expect(rows.map((r) => r.actorId)).toEqual(['awa', 'paul', 'awa'])
  })

  it('on upload each group goes up as its own person, in order', async () => {
    setOutboxActor('awa')
    await repo.addCustomer(ctxFor('awa'), 'Client 1', undefined, 0)
    setOutboxActor('paul')
    await repo.addCustomer(ctxFor('paul', 'manager'), 'Client 2', undefined, 0)
    await engine.runSync(server, sctx)
    expect(server.pushedAs).toEqual(['awa', 'paul'])
    expect((await getSyncSummary()).pendingGroups).toBe(0)
    expect(server.count('customers')).toBe(2)
  })

  it('a person the server does not know on this device is refused, and nobody else is held up', async () => {
    server.allowedActors = new Set(['awa'])
    setOutboxActor('mallory')
    await repo.addCustomer(ctxFor('mallory'), 'Forged', undefined, 0)
    setOutboxActor('awa')
    await repo.addCustomer(ctxFor('awa'), 'Honest', undefined, 0)
    await engine.runSync(server, sctx)
    const s = await getSyncSummary()
    expect(s.rejectedGroups).toBe(1)
    expect(server.rows('customers').map((c) => c.name)).toEqual(['Honest'])
  })

  it('without an actor (signed-in person works alone) nothing changes', async () => {
    await repo.addCustomer(ctxFor('awa'), 'Solo', undefined, 0)
    await engine.runSync(server, sctx)
    expect(server.pushedAs).toEqual([undefined])
  })
})

describe('taking over with a PIN, checked on the device', () => {
  it('each person has their own PIN and their own lockout', async () => {
    await enrollLocalPin('awa', '4821', 'Awa', 1000)
    await enrollLocalPin('paul', '7392', 'Paul', 1000)
    expect((await verifyLocalPin('paul', '7392')).ok).toBe(true)
    expect((await verifyLocalPin('paul', '4821')).ok).toBe(false) // Awa's PIN does not open Paul
    for (let i = 0; i < 5; i++) await verifyLocalPin('awa', '0000')
    expect(await verifyLocalPin('awa', '4821')).toMatchObject({ ok: false, reason: 'locked' }) // Awa is locked out…
    expect((await verifyLocalPin('paul', '7392')).ok).toBe(true) // …Paul is not
  })

  it('the roster remembers people, and drops those the server no longer allows (with their offline PIN)', async () => {
    await enrollLocalPin('awa', '4821', 'Awa', 1000)
    await enrollLocalPin('paul', '7392', 'Paul', 1000)
    await rememberPerson({ userId: 'awa', name: 'Awa', role: 'cashier', shopIds: ['s1'] })
    await rememberPerson({ userId: 'paul', name: 'Paul', role: 'manager', shopIds: [] })
    expect(Object.keys(await loadRoster()).sort()).toEqual(['awa', 'paul'])

    const gone = await pruneRoster(new Set(['awa']), 'awa') // Paul was deactivated
    expect(gone).toEqual(['paul'])
    expect(Object.keys(await loadRoster())).toEqual(['awa'])
    expect(await hasLocalPin('paul')).toBe(false) // his PIN no longer works offline
    expect(await hasLocalPin('awa')).toBe(true)
  })

  it('never drops the person currently signed in, even if the server list is empty', async () => {
    await rememberPerson({ userId: 'awa', name: 'Awa', role: 'cashier', shopIds: [] })
    expect(await pruneRoster(new Set(), 'awa')).toEqual([])
    expect(Object.keys(await loadRoster())).toEqual(['awa'])
  })
})
