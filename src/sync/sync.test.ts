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

const { db, newId } = await import('../data/db')
const repo = await import('../data/repo')
const { rebuildCost } = await import('../data/projection')
const engine = await import('./engine')
const { getSyncSummary, syncStatus, unsyncedTooLong, offlineLimitExceeded } = await import('./status')
const { FakeServer } = await import('./testing/fakeServer')
const { classifyServerError } = await import('./transport')
const { toServer } = await import('./mappers')
const { buildSale } = await import('../domain/pos')
const { receive, emptyCostState } = await import('../domain/costing')
const fin = await import('../data/financeRepo')
const { buildRepayment, openSalesOf } = await import('../domain/finance')
const pur = await import('../data/purchasingRepo')
const { buildReceipt } = await import('../domain/purchasing')

const ctx: import('../data/repo').Ctx = { tenantId: 't1', shopId: 's1', userId: 'u1', role: 'owner', oversellPolicy: 'allow_and_flag' }
const sctx = { tenantId: 't1', deviceName: 'Phone' }

let server: InstanceType<typeof FakeServer>

/** Becoming a different (or brand-new, empty) device. */
async function newDevice() {
  await Promise.all(db.tables.map((t) => t.clear()))
  store.set('stockcm.deviceId', newId())
}

beforeEach(async () => {
  server = new FakeServer()
  await newDevice()
})

async function addWater(barcode?: string) {
  const id = await repo.addProduct(ctx, {
    name: 'Eau 1.5L', barcode, baseUnit: 'bottle', minStock: 6, taxRateBp: 0, isService: false,
    units: [
      { name: 'bottle', factor: 1, sellPrice: 500, isBase: true },
      { name: 'carton', factor: 24, sellPrice: 11000, isBase: false },
    ],
    openingQty: 48, openingTotalCost: 24000,
  })
  const units = await db.units.where('productId').equals(id).toArray()
  return { id, bottle: units.find((u) => u.isBase)!, carton: units.find((u) => u.factor === 24)! }
}

const line = (p: { id: string }, u: { id: string; name: string; factor: number; sellPrice: number }, qty: number) => ({
  productId: p.id, productName: 'Eau 1.5L', unitId: u.id, unitName: u.name, factor: u.factor,
  unitPrice: u.sellPrice, quantity: qty, lineDiscount: 0, taxRateBp: 0, isService: false,
})

const sell = (w: Awaited<ReturnType<typeof addWater>>, bottles: number) =>
  repo.checkout(ctx, { lines: [line(w, w.bottle, bottles)], payments: [{ method: 'cash', amount: bottles * 500 }] })

describe('push', () => {
  it('uploads a sale with everything it produced, then the outbox is empty', async () => {
    const w = await addWater()
    await sell(w, 3)
    const r = await engine.runSync(server, sctx)
    expect(r.pushedGroups).toBe(2) // the product group and the sale group
    expect(await db.outbox.count()).toBe(0)
    expect(server.count('products')).toBe(1)
    expect(server.count('product_units')).toBe(2)
    expect(server.count('stock_movements')).toBe(2)
    expect(server.count('sales')).toBe(1)
    expect(server.count('sale_lines')).toBe(1)
    expect(server.count('financial_transactions')).toBe(1)
    expect(syncStatus(await getSyncSummary(), false)).toBe('synced')
  })

  it('keeps everything when the server cannot be reached, and sends it later', async () => {
    const w = await addWater()
    await sell(w, 2)
    server.online = false
    const r = await engine.runSync(server, sctx)
    expect(r.offline).toBe(true)
    expect(await db.outbox.count()).toBeGreaterThan(0)
    expect(syncStatus(await getSyncSummary(), false)).toBe('pending')

    server.online = true
    const r2 = await engine.runSync(server, sctx, { manual: true })
    expect(r2.offline).toBe(false)
    expect(await db.outbox.count()).toBe(0)
    expect(server.count('sales')).toBe(1)
  })

  it('after a failed upload it waits before retrying by itself, but a manual run goes straight through', async () => {
    const w = await addWater()
    await sell(w, 1)
    server.pushFails = true
    await engine.runSync(server, sctx)
    const first = (await db.outbox.toCollection().first())!
    expect(first.attempts).toBe(1)
    expect(first.nextAttemptAt).toBeTruthy()

    server.pushFails = false
    const auto = await engine.runSync(server, sctx) // still inside the back-off window
    expect(auto.offline).toBe(true)
    expect(server.count('sales')).toBe(0)

    await engine.runSync(server, sctx, { manual: true })
    expect(server.count('sales')).toBe(1)
    expect(await db.outbox.count()).toBe(0)
  })

  it('a lost reply is safe: the retry creates no duplicates', async () => {
    const w = await addWater()
    await engine.runSync(server, sctx) // product is already on the server
    await sell(w, 3)
    server.failAfterApply = true
    const r = await engine.runSync(server, sctx)
    expect(r.offline).toBe(true)
    expect(server.count('sales')).toBe(1) // the server did apply it
    expect(await db.outbox.count()).toBeGreaterThan(0) // but this device cannot know

    server.failAfterApply = false
    await engine.runSync(server, sctx, { manual: true })
    expect(await db.outbox.count()).toBe(0)
    expect(server.count('sales')).toBe(1)
    expect(server.count('sale_lines')).toBe(1)
    expect(server.count('financial_transactions')).toBe(1)
    expect(server.count('stock_movements')).toBe(2)
  })

  it('a refused sale is flagged, never retried by itself, and can be retried after the fix', async () => {
    const w = await addWater()
    const sale = await sell(w, 2)
    await engine.runSync(server, sctx) // product group goes through first
    // not yet synced sale: corrupt its total, as a damaged record or tampering would
    await sell(w, 1)
    const bad = await db.outbox.filter((o) => o.table === 'sales').first()
    const original = bad!.payload as { total: number }
    await db.outbox.update(bad!.seq!, { payload: { ...original, total: 99999 } })

    await engine.runSync(server, sctx)
    const after = await getSyncSummary()
    expect(after.rejectedGroups).toBe(1)
    expect(syncStatus(after, false)).toBe('failed')
    const err = (await db.outbox.filter((o) => o.status === 'rejected').first())!.lastError
    expect(err).toContain('do not add up')

    const callsBefore = server.pushCalls
    await engine.runSync(server, sctx)
    expect(server.pushCalls).toBe(callsBefore) // not retried automatically

    await db.outbox.update(bad!.seq!, { payload: original })
    await engine.retryGroup(bad!.groupId)
    await engine.runSync(server, sctx)
    expect(await db.outbox.count()).toBe(0)
    expect(server.count('sales')).toBe(2)
    expect(sale.sale.id).toBeTruthy()
  })

  it('keeps a history of every attempt', async () => {
    const w = await addWater()
    await sell(w, 1)
    server.pushFails = true
    await engine.runSync(server, sctx)
    server.pushFails = false
    await engine.runSync(server, sctx, { manual: true })
    const outcomes = (await db.syncLog.toArray()).map((l) => l.outcome)
    expect(outcomes).toContain('network')
    expect(outcomes).toContain('ok')
  })

  it('stops a revoked device', async () => {
    await addWater()
    const id = store.get('stockcm.deviceId')!
    server.revoked.add(id)
    const r = await engine.runSync(server, sctx)
    expect(r.revoked).toBe(true)
    expect(engine.getEngineSnapshot().revoked).toBe(true)
    expect(server.count('products')).toBe(0)
  })
})

describe('conflicts', () => {
  it('two devices create a product with the same barcode: flagged as a conflict, then resolved', async () => {
    await addWater('6001234')
    await engine.runSync(server, sctx)
    expect(server.count('products')).toBe(1)

    await newDevice() // a second shop phone that never saw the first product
    await addWater('6001234')
    await engine.runSync(server, sctx)
    const s = await getSyncSummary()
    expect(s.conflictGroups).toBe(1)
    expect(syncStatus(s, false)).toBe('conflict')
    expect(server.count('products')).toBe(1) // nothing half-applied

    const group = (await db.outbox.filter((o) => o.status === 'conflict').first())!.groupId
    await engine.resolveBarcodeConflict(group)
    await engine.runSync(server, sctx)
    expect(await db.outbox.count()).toBe(0)
    expect(server.count('products')).toBe(2)
    expect(server.rows('products').filter((p) => p.barcode === '6001234')).toHaveLength(1)
  })
})

describe('pull and recovery', () => {
  it('a replacement device recovers products, stock, sales and customer debt', async () => {
    const w = await addWater()
    const c = await repo.addCustomer(ctx, 'Mme Tchoua', '677000111', 50000)
    await repo.checkout(ctx, {
      lines: [line(w, w.bottle, 4)],
      payments: [{ method: 'cash', amount: 1000 }, { method: 'credit', amount: 1000 }],
      customerId: c.id,
    })
    await engine.runSync(server, sctx)
    const original = await db.costs.get(`s1:${w.id}`)

    await newDevice() // old phone lost, new empty phone
    const r = await engine.runSync(server, sctx)
    expect(r.pulledRows).toBeGreaterThan(0)
    expect(await db.products.count()).toBe(1)
    expect(await db.units.count()).toBe(2)
    expect(await db.sales.count()).toBe(1)
    expect((await db.saleLines.toArray())[0].productName).toBe('Eau 1.5L')
    expect(await repo.customerBalance(c.id)).toBe(1000)
    expect(await db.costs.get(`s1:${w.id}`)).toMatchObject({ quantity: original!.quantity, value: original!.value })
  })

  it('downloads in pages and completes', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.addProduct(ctx, {
        name: `P${i}`, baseUnit: 'piece', minStock: 0, taxRateBp: 0, isService: false,
        units: [{ name: 'piece', factor: 1, sellPrice: 100, isBase: true }], openingQty: 10, openingTotalCost: 500,
      })
    }
    await engine.runSync(server, sctx)
    await newDevice()
    server.pageLimit = 2
    await engine.runSync(server, sctx)
    expect(await db.products.count()).toBe(5)
    expect(await db.movements.count()).toBe(5)
    expect(await db.costs.count()).toBe(5)
  })

  it('two devices sell the same stock while offline: both sales are kept and both devices agree', async () => {
    const w = await addWater() // 48 bottles
    await engine.runSync(server, sctx)

    // This phone sells 30 bottles and is offline.
    await sell(w, 30)

    // Meanwhile another phone (built as a real client would) sold 30 and already synced.
    const other = buildSale({
      newId, tenantId: 't1', shopId: 's1', userId: 'u2', deviceId: 'other-phone', role: 'cashier',
      saleNumber: 'ZZZZ-0001', nowIso: new Date(Date.now() + 1000).toISOString(),
      lines: [line(w, w.bottle, 30)], payments: [{ method: 'cash', amount: 15000 }],
      costStates: { [w.id]: receive(emptyCostState, 48, 24000) }, oversellPolicy: 'allow_and_flag',
    })
    const wire = [
      { t: 'sales', rows: [other.sale] }, { t: 'sale_lines', rows: other.lines },
      { t: 'stock_movements', rows: other.movements.map((m) => ({ ...m, tenantId: 't1' })) },
      { t: 'financial_transactions', rows: other.transactions },
    ].flatMap((g) => g.rows.map((r) => ({ op_id: newId(), table: g.t, payload: toServer(g.t, r as Record<string, unknown>) })))
    await server.push('other-phone', wire)

    await engine.runSync(server, sctx, { manual: true })
    expect(server.count('sales')).toBe(2)
    expect(await db.sales.count()).toBe(2)
    // 48 - 30 - 30 = -12 on this device, and on the server's ledger
    const serverStock = server.rows('stock_movements').reduce((t, m) => t + Number(m.quantity), 0)
    expect(serverStock).toBe(-12)
    expect((await db.costs.get(`s1:${w.id}`))!.quantity).toBe(-12)
  })
})

describe('stock projection', () => {
  it('rebuilding from the ledger gives exactly the state built up step by step', async () => {
    const w = await addWater()
    await repo.receiveStock(ctx, w.id, w.carton, 2, 25000)
    await sell(w, 5)
    await repo.removeStock(ctx, w.id, 3, 'damaged', 'dropped')
    await sell(w, 7)
    const incremental = await db.costs.get(`s1:${w.id}`)
    const rebuilt = await rebuildCost('s1', w.id)
    expect(rebuilt).toMatchObject({ quantity: incremental!.quantity, value: incremental!.value })
  })
})

describe('status rules', () => {
  const base = { pendingGroups: 0, rejectedGroups: 0, conflictGroups: 0 }
  it('maps the situation to the five visible states', () => {
    expect(syncStatus(base, false)).toBe('synced')
    expect(syncStatus({ ...base, pendingGroups: 2 }, false)).toBe('pending')
    expect(syncStatus({ ...base, pendingGroups: 2 }, true)).toBe('syncing')
    expect(syncStatus({ ...base, rejectedGroups: 1 }, false)).toBe('failed')
    expect(syncStatus({ ...base, rejectedGroups: 1, conflictGroups: 1 }, false)).toBe('conflict')
  })
  it('warns after 48 hours unsynced and past the 30-day offline limit', () => {
    const now = Date.parse('2026-11-17T12:00:00Z')
    expect(unsyncedTooLong({ ...base, oldestPendingAt: '2026-11-15T13:00:00Z' }, now)).toBe(false)
    expect(unsyncedTooLong({ ...base, oldestPendingAt: '2026-11-15T11:00:00Z' }, now)).toBe(true)
    expect(offlineLimitExceeded('2026-10-20T00:00:00Z', now)).toBe(false)
    expect(offlineLimitExceeded('2026-10-10T00:00:00Z', now)).toBe(true)
  })
  it('classifies server errors', () => {
    expect(classifyServerError({ message: 'TypeError: Failed to fetch' })).toBe('network')
    expect(classifyServerError({ code: '57014', message: 'statement timeout' })).toBe('network')
    expect(classifyServerError({ code: '28000', message: 'not authenticated' })).toBe('auth')
    expect(classifyServerError({ code: 'PGRST301', message: 'JWT expired' })).toBe('auth')
    expect(classifyServerError({ code: '23514', message: 'check violation' })).toBe('permanent')
    expect(classifyServerError({ code: '23505', message: 'duplicate' })).toBe('permanent')
    expect(classifyServerError({ code: '42501', message: 'rls' })).toBe('permanent')
  })
  it('back-off grows and is capped', () => {
    expect(engine.backoffMs(1)).toBe(5_000)
    expect(engine.backoffMs(3)).toBe(20_000)
    expect(engine.backoffMs(30)).toBe(15 * 60_000)
  })
})

describe('money records sync', () => {
  async function creditSale10k() {
    const w = await addWater()
    const c = await repo.addCustomer(ctx, 'Mme Tchoua', '677000111', 100000)
    const r = await repo.checkout(ctx, {
      lines: [line(w, w.carton, 1)], // 11,000
      payments: [{ method: 'cash', amount: 1000 }, { method: 'credit', amount: 10000 }], customerId: c.id,
    })
    return { c, sale: r.sale }
  }

  it('uploads a repayment, an expense and a cash-session closure, then a new device recovers them', async () => {
    const { c } = await creditSale10k()
    await fin.repayDebt(ctx, { customerId: c.id, amount: 4000, method: 'cash' })
    await fin.recordExpense(ctx, { category: 'transport', amount: 1500, method: 'cash' })
    const session = await fin.openCashSession(ctx, 5000)
    await fin.closeCashSession(ctx, session.id, 9000)
    await engine.runSync(server, sctx)
    expect(await db.outbox.count()).toBe(0)
    expect(server.count('payments')).toBe(1)
    expect(server.count('payment_allocations')).toBe(1)
    expect(server.count('expenses')).toBe(1)
    expect(server.count('cash_sessions')).toBe(1)
    expect(server.count('cash_session_closures')).toBe(1)

    await newDevice()
    await engine.runSync(server, sctx)
    expect(await repo.customerBalance(c.id)).toBe(6000)
    expect(await db.expenses.count()).toBe(1)
    expect(await db.cashClosures.count()).toBe(1)
    expect(await db.payments.count()).toBe(1)
  })

  it('a repayment whose records do not match is refused whole', async () => {
    const { c } = await creditSale10k()
    await engine.runSync(server, sctx)
    await fin.repayDebt(ctx, { customerId: c.id, amount: 4000, method: 'cash' })
    const bad = await db.outbox.filter((o) => o.table === 'customer_account_entries').first()
    await db.outbox.update(bad!.seq!, { payload: { ...(bad!.payload as object), amount: -1 } })
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).rejectedGroups).toBe(1)
    expect(server.count('payments')).toBe(0)
    expect(server.count('financial_transactions')).toBe(1) // the sale's cash only; none of the refused repayment
  })

  it('two devices each record the SAME full repayment: both are kept (the money was really received), customer ends in credit', async () => {
    const { c, sale } = await creditSale10k()
    await engine.runSync(server, sctx)
    await fin.repayDebt(ctx, { customerId: c.id, amount: 10000, method: 'cash' }) // this phone, offline

    // another phone already uploaded the same repayment
    const other = buildRepayment({
      newId, tenantId: 't1', shopId: 's1', userId: 'u2', deviceId: 'other', nowIso: new Date(Date.now() + 1000).toISOString(),
      customerId: c.id, method: 'cash', amount: 10000, reference: 'ZZZZ-RP-0001',
      openSales: openSalesOf([{ id: sale.id, occurredAt: sale.occurredAt, outstanding: 10000 }], []),
    })
    const wire = [
      { t: 'financial_transactions', rows: [other.transaction] }, { t: 'payments', rows: [other.payment] },
      { t: 'payment_allocations', rows: other.allocations }, { t: 'customer_account_entries', rows: [other.entry] },
    ].flatMap((g) => g.rows.map((r) => ({ op_id: newId(), table: g.t, payload: toServer(g.t, r as unknown as Record<string, unknown>) })))
    await server.push('other', wire)

    await engine.runSync(server, sctx, { manual: true })
    expect(server.count('payments')).toBe(2)
    expect(await db.payments.count()).toBe(2)
    expect(await repo.customerBalance(c.id)).toBe(-10000) // 10,000 owed - 20,000 paid = 10,000 in the customer's favour
    expect((await getSyncSummary()).rejectedGroups).toBe(0)
  })
})

describe('purchasing sync', () => {
  async function orderRice() {
    const w = await addWater()
    const sup = await pur.addSupplier(ctx, 'Grossiste Akwa')
    const o = await pur.createPurchase(ctx, {
      supplierId: sup.id, invoiceNumber: 'F-1',
      lines: [{ productId: w.id, unitId: w.bottle.id, quantity: 100, totalCost: 40000 }],
    })
    return { w, sup, o }
  }

  it('uploads orders, deliveries, payments and returns; a new device recovers stock and what we owe', async () => {
    const { w, sup, o } = await orderRice()
    await pur.receiveGoods(ctx, o.purchase.id, [{ purchaseLineId: o.lines[0].id, baseQuantity: 60 }], { amount: 10000, method: 'cash' })
    await pur.receiveGoods(ctx, o.purchase.id, [{ purchaseLineId: o.lines[0].id, baseQuantity: 40 }])
    await pur.paySupplier(ctx, { supplierId: sup.id, amount: 5000, method: 'mtn_momo' })
    await pur.returnToSupplier(ctx, { supplierId: sup.id, productId: w.id, baseQuantity: 10, creditValue: 3500, reason: 'damaged' })
    const stockHere = (await db.costs.get(`s1:${w.id}`))!
    const owedHere = await pur.supplierPayable(sup.id)
    expect(owedHere).toBe(40000 - 10000 - 5000 - 3500)

    await engine.runSync(server, sctx)
    expect(await db.outbox.count()).toBe(0)
    expect(server.count('suppliers')).toBe(1)
    expect(server.count('purchases')).toBe(1)
    expect(server.count('goods_receipts')).toBe(2)
    expect(server.count('supplier_account_entries')).toBe(5) // 2 credits, 1 payment on delivery, 1 payment, 1 return

    await newDevice()
    await engine.runSync(server, sctx)
    expect(await pur.supplierPayable(sup.id)).toBe(owedHere)
    const stockThere = (await db.costs.get(`s1:${w.id}`))!
    expect(stockThere.quantity).toBe(stockHere.quantity)
    expect(stockThere.value).toBe(stockHere.value)
    expect(await db.purchases.count()).toBe(1)
    expect(await db.receiptLines.count()).toBe(2)
  })

  it('a delivery whose debt does not match the goods is refused whole', async () => {
    const { o } = await orderRice()
    await engine.runSync(server, sctx)
    await pur.receiveGoods(ctx, o.purchase.id, [{ purchaseLineId: o.lines[0].id, baseQuantity: 50 }])
    const bad = await db.outbox.filter((r) => r.table === 'supplier_account_entries').first()
    await db.outbox.update(bad!.seq!, { payload: { ...(bad!.payload as object), amount: 1 } })
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).rejectedGroups).toBe(1)
    expect(server.count('goods_receipts')).toBe(0)
    expect(server.count('stock_movements')).toBe(1) // only the opening stock from the product group
  })

  it('two storekeepers record the same arrival: the second is refused so stock is not counted twice', async () => {
    const { o } = await orderRice()
    await engine.runSync(server, sctx)
    await pur.receiveGoods(ctx, o.purchase.id, [{ purchaseLineId: o.lines[0].id, baseQuantity: 100 }]) // this phone, offline

    const priorLines: import('../domain/purchasing').ReceiptLineRecord[] = []
    const other = buildReceipt({
      newId, tenantId: 't1', shopId: 's1', userId: 'u2', deviceId: 'other', nowIso: new Date(Date.now() + 1000).toISOString(),
      purchase: o.purchase, lines: o.lines, priorReceiptLines: priorLines, deliveries: [{ purchaseLineId: o.lines[0].id, baseQuantity: 100 }],
    })
    const wire = [
      { t: 'goods_receipts', rows: [other.receipt] }, { t: 'goods_receipt_lines', rows: other.lines },
      { t: 'stock_movements', rows: other.movements.map((m) => ({ ...m, tenantId: 't1' })) },
      { t: 'supplier_account_entries', rows: other.entries },
    ].flatMap((g) => g.rows.map((r) => ({ op_id: newId(), table: g.t, payload: toServer(g.t, r as unknown as Record<string, unknown>) })))
    await server.push('other', wire) // the other phone got there first

    await engine.runSync(server, sctx, { manual: true })
    const s = await getSyncSummary()
    expect(s.rejectedGroups).toBe(1) // ours is refused: it would exceed what was ordered
    expect(server.count('goods_receipts')).toBe(1)
    const err = (await db.outbox.filter((r) => r.status === 'rejected').first())!.lastError
    expect(err).toContain('more received than ordered')
  })
})
