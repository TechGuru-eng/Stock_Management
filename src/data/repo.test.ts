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

const { db } = await import('./db')
const repo = await import('./repo')

const ctx: import('./repo').Ctx = {
  tenantId: 't1', shopId: 's1', userId: 'u1', role: 'cashier', oversellPolicy: 'allow_and_flag',
}

async function makeWater() {
  const id = await repo.addProduct(ctx, {
    name: 'Eau 1.5L', baseUnit: 'bottle', minStock: 6, taxRateBp: 0, isService: false,
    units: [
      { name: 'bottle', factor: 1, sellPrice: 500, isBase: true },
      { name: 'carton', factor: 24, sellPrice: 11000, isBase: false },
    ],
    openingQty: 48, openingTotalCost: 24000,
  })
  const units = await db.units.where('productId').equals(id).toArray()
  return { id, bottle: units.find((u) => u.isBase)!, carton: units.find((u) => u.factor === 24)! }
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

const line = (p: { id: string }, u: { id: string; name: string; factor: number; sellPrice: number }, qty: number) => ({
  productId: p.id, productName: 'Eau 1.5L', unitId: u.id, unitName: u.name, factor: u.factor,
  unitPrice: u.sellPrice, quantity: qty, lineDiscount: 0, taxRateBp: 0, isService: false,
})

describe('local repository', () => {
  it('creates a product with opening stock, costed and queued for sync', async () => {
    const w = await makeWater()
    const cost = await db.costs.get(`s1:${w.id}`)
    expect(cost).toMatchObject({ quantity: 48, value: 24000 })
    expect(await db.movements.count()).toBe(1)
    expect(await db.outbox.where('status').equals('pending').count()).toBe(1 + 2 + 1) // product, 2 units, movement
  })

  it('rejects a duplicate barcode', async () => {
    const mk = () => repo.addProduct(ctx, {
      name: 'A', barcode: '600123', baseUnit: 'piece', minStock: 0, taxRateBp: 0, isService: false,
      units: [{ name: 'piece', factor: 1, sellPrice: 100, isBase: true }], openingQty: 0, openingTotalCost: 0,
    })
    await mk()
    await expect(mk()).rejects.toThrow('barcode')
  })

  it('a split sale commits every record together and updates stock', async () => {
    const w = await makeWater()
    const c = await repo.addCustomer(ctx, 'Mme Tchoua', '677000111', 50000)
    const r = await repo.checkout(ctx, {
      lines: [line(w, w.bottle, 3), line(w, w.carton, 1)], // 3 bottles + 1 carton = 27 bottles, 1500 + 11000 = 12500
      payments: [{ method: 'cash', amount: 5000 }, { method: 'mtn_momo', amount: 2500 }, { method: 'credit', amount: 5000 }],
      customerId: c.id,
    })
    expect(r.sale.total).toBe(12500)
    expect((await db.costs.get(`s1:${w.id}`))!.quantity).toBe(48 - 27)
    expect(await repo.customerBalance(c.id)).toBe(5000)
    expect(await db.transactions.count()).toBe(2)
    expect(await db.saleLines.count()).toBe(2)
  })

  it('a failed sale leaves no partial records (atomic)', async () => {
    const w = await makeWater()
    const before = { m: await db.movements.count(), s: await db.sales.count(), o: await db.outbox.count() }
    await expect(
      repo.checkout(ctx, { lines: [line(w, w.bottle, 3)], payments: [{ method: 'cash', amount: 1 }] }),
    ).rejects.toThrow()
    expect({ m: await db.movements.count(), s: await db.sales.count(), o: await db.outbox.count() }).toEqual(before)
  })

  it('sale numbers are unique and sequential on a device', async () => {
    const w = await makeWater()
    const a = await repo.checkout(ctx, { lines: [line(w, w.bottle, 1)], payments: [{ method: 'cash', amount: 500 }] })
    const b = await repo.checkout(ctx, { lines: [line(w, w.bottle, 1)], payments: [{ method: 'cash', amount: 500 }] })
    expect(a.sale.saleNumber).not.toBe(b.sale.saleNumber)
    expect(a.sale.saleNumber.endsWith('-0001')).toBe(true)
    expect(b.sale.saleNumber.endsWith('-0002')).toBe(true)
  })

  it('offline sales survive an application restart', async () => {
    const w = await makeWater()
    await repo.checkout(ctx, { lines: [line(w, w.bottle, 2)], payments: [{ method: 'cash', amount: 1000 }] })
    db.close()
    await db.open() // simulates closing and reopening the app
    expect(await db.sales.count()).toBe(1)
    expect(await db.outbox.filter((o) => o.table === 'sales').count()).toBe(1)
    expect((await db.costs.get(`s1:${w.id}`))!.quantity).toBe(46)
  })

  it('removing stock needs a reason and is costed', async () => {
    const w = await makeWater()
    await expect(repo.removeStock(ctx, w.id, 2, 'damaged', ' ')).rejects.toThrow('reason')
    await repo.removeStock(ctx, w.id, 2, 'damaged', 'broken in transport')
    const cost = await db.costs.get(`s1:${w.id}`)
    expect(cost).toMatchObject({ quantity: 46, value: 23000 })
  })
})
