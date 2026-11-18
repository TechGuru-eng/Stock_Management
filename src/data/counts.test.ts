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
const counts = await import('./countsRepo')
const { rebuildCost } = await import('./projection')
const engine = await import('../sync/engine')
const { FakeServer } = await import('../sync/testing/fakeServer')
const { getSyncSummary } = await import('../sync/status')

const manager: import('./repo').Ctx = { tenantId: 't1', shopId: 's1', userId: 'mgr', role: 'manager', oversellPolicy: 'allow_and_flag' }
const keeper: import('./repo').Ctx = { ...manager, userId: 'sk', role: 'storekeeper' }
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

async function product(name: string, qty: number, cost: number) {
  return repo.addProduct(manager, {
    name, baseUnit: 'piece', minStock: 0, taxRateBp: 0, isService: false,
    units: [{ name: 'piece', factor: 1, sellPrice: cost * 2, isBase: true }], openingQty: qty, openingTotalCost: qty * cost,
  })
}
const stock = async (p: string) => (await db.costs.get(`s1:${p}`))?.quantity ?? 0
const worth = async (p: string) => (await db.costs.get(`s1:${p}`))?.value ?? 0

describe('a stock count', () => {
  it('records what was counted together with what the system expected and the cost at that moment', async () => {
    const p = await product('Eau', 10, 500)
    const c = await counts.startCount(keeper, { name: 'November', blind: true })
    const line = await counts.recordCount(keeper, c.id, p, 7)
    expect(line).toMatchObject({ counted: 7, expected: 10, unitCost: 500 })
    expect(await stock(p)).toBe(10) // counting alone changes nothing
  })

  it('approving adjusts only the difference, at average cost, and the numbers still add up', async () => {
    const water = await product('Eau', 10, 500)
    const rice = await product('Riz', 20, 700)
    const oil = await product('Huile', 5, 1200)
    const c = await counts.startCount(keeper, { name: 'November', blind: true })
    await counts.recordCount(keeper, c.id, water, 7) // 3 missing
    await counts.recordCount(keeper, c.id, rice, 22) // 2 extra
    await counts.recordCount(keeper, c.id, oil, 5) // matches
    const r = await counts.approveCount(manager, c.id)
    expect(r.adjusted).toBe(2)
    expect([await stock(water), await worth(water)]).toEqual([7, 3500])
    expect([await stock(rice), await worth(rice)]).toEqual([22, 15400])
    expect(await stock(oil)).toBe(5)
    expect((await db.movements.filter((m) => m.type === 'count_adjustment').toArray()).map((m) => m.quantity).sort()).toEqual([-3, 2])
  })

  it('sales made while counting continues are not undone: the adjustment is the difference measured at the time of the count', async () => {
    const p = await product('Eau', 10, 500)
    const c = await counts.startCount(keeper, { name: 'Busy day', blind: true })
    await counts.recordCount(keeper, c.id, p, 7) // 3 missing at that moment
    await repo.removeStock(manager, p, 2, 'damaged', 'dropped') // later, 2 more leave
    await counts.approveCount(manager, c.id)
    expect(await stock(p)).toBe(5) // 10 - 2 - 3, not forced back to 7
  })

  it('a recount replaces the earlier figure; the earlier line is kept', async () => {
    const p = await product('Eau', 10, 500)
    const c = await counts.startCount(keeper, { name: 'N', blind: false })
    await counts.recordCount(keeper, c.id, p, 4)
    await new Promise((r) => setTimeout(r, 5))
    await counts.recordCount(keeper, c.id, p, 10) // second look: it was fine
    expect(await db.countLines.count()).toBe(2)
    expect((await counts.approveCount(manager, c.id)).adjusted).toBe(0)
    expect(await stock(p)).toBe(10)
  })

  it('who may do what: a storekeeper counts but cannot approve; nobody can decide twice; a rejected count changes nothing', async () => {
    const p = await product('Eau', 10, 500)
    const c = await counts.startCount(keeper, { name: 'N', blind: true })
    await counts.recordCount(keeper, c.id, p, 1)
    await expect(counts.approveCount(keeper, c.id)).rejects.toThrow(/not allowed/)
    await expect(counts.rejectCount(manager, c.id, ' ')).rejects.toThrow(/say why/)
    await counts.rejectCount(manager, c.id, 'recount the back room')
    await expect(counts.approveCount(manager, c.id)).rejects.toThrow(/already been decided/)
    await expect(counts.recordCount(keeper, c.id, p, 2)).rejects.toThrow(/already been decided/)
    expect(await stock(p)).toBe(10)
    await expect(counts.startCount({ ...manager, role: 'cashier' }, { name: 'x', blind: true })).rejects.toThrow(/not allowed/)
  })

  it('refuses bad numbers and a count of another shop', async () => {
    const p = await product('Eau', 10, 500)
    const c = await counts.startCount(keeper, { name: 'N', blind: true })
    for (const n of [-1, 1.5, NaN]) await expect(counts.recordCount(keeper, c.id, p, n)).rejects.toThrow(/whole number/)
    await expect(counts.recordCount({ ...keeper, shopId: 's2' }, c.id, p, 3)).rejects.toThrow(/another shop/)
  })
})

describe('counts and sync', () => {
  it('upload, then a second device ends up with the same stock; the approval goes up as one group', async () => {
    const water = await product('Eau', 10, 500)
    const c = await counts.startCount(keeper, { name: 'N', blind: true })
    await counts.recordCount(keeper, c.id, water, 6)
    await counts.approveCount(manager, c.id)
    const decisionGroup = (await db.outbox.toArray()).find((o) => o.table === 'stock_count_decisions')!.groupId
    expect((await db.outbox.where('groupId').equals(decisionGroup).toArray()).map((o) => o.table).sort()).toEqual(['stock_count_decisions', 'stock_movements'])

    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).pendingGroups).toBe(0)
    expect(server.count('stock_count_decisions')).toBe(1)

    await newDevice()
    await engine.runSync(server, sctx)
    expect((await rebuildCost('s1', water)).quantity).toBe(6)
    expect(await db.countDecisions.count()).toBe(1)
    expect(await db.countLines.count()).toBe(1)
  })

  it('the server refuses an approval whose adjustment does not match the count', async () => {
    const water = await product('Eau', 10, 500)
    const c = await counts.startCount(keeper, { name: 'N', blind: true })
    await counts.recordCount(keeper, c.id, water, 6)
    await counts.approveCount(manager, c.id)
    const mv = (await db.outbox.toArray()).find((o) => o.table === 'stock_movements' && (o.payload as { type: string }).type === 'count_adjustment')!
    await db.outbox.update(mv.seq!, { payload: { ...(mv.payload as object), quantity: -1 } }) // tampered
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).rejectedGroups).toBe(1)
    expect(server.count('stock_count_decisions')).toBe(0)
  })

  it('a line that arrives after the count was decided is refused', async () => {
    const water = await product('Eau', 10, 500)
    const c = await counts.startCount(keeper, { name: 'N', blind: true })
    await counts.rejectCount(manager, c.id, 'not ready')
    await engine.runSync(server, sctx)
    const late = { id: newId(), tenantId: 't1', countId: c.id, productId: water, counted: 3, expected: 10, unitCost: 500, countedBy: 'sk', countedAt: new Date().toISOString() }
    await db.outbox.add({ id: newId(), groupId: late.id, table: 'stock_count_lines', payload: late, createdAt: late.countedAt, status: 'pending', attempts: 0 })
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).rejectedGroups).toBe(1)
  })
})
