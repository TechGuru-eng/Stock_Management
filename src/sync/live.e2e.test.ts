/**
 * LIVE end-to-end test against a real Supabase project. Skipped unless
 * E2E_EMAIL and E2E_PASSWORD are set (a throwaway test user). It runs the real
 * sync engine and the real transport; only IndexedDB is simulated.
 *
 *   E2E_EMAIL=... E2E_PASSWORD=... npx vitest run src/sync/live.e2e.test.ts
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const email = env.E2E_EMAIL
const password = env.E2E_PASSWORD

const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
}

describe.skipIf(!email || !password)('live sync against Supabase', () => {
  it('syncs a real sale end to end, replays safely, recovers on a new device, and rejects tampering', async () => {
    const { supabase } = await import('../lib/supabase')
    const { db, newId } = await import('../data/db')
    const repo = await import('../data/repo')
    const engine = await import('./engine')
    const { supabaseTransport } = await import('./supabaseTransport')
    const { toServer } = await import('./mappers')
    if (!supabase) throw new Error('Supabase is not configured (.env.local)')

    const signIn = await supabase.auth.signInWithPassword({ email: email!, password: password! })
    expect(signIn.error).toBeNull()
    const userId = signIn.data.user!.id

    // The user has no business yet: create one the same way the app does.
    const onboard = await supabase.rpc('onboard_business', {
      p: { business_name: 'E2E Sync Test', category: 'general_store', town: 'Douala', owner_name: 'E2E', owner_phone: '+237677000000' },
    })
    expect(onboard.error).toBeNull()
    const tenantId = onboard.data as string
    const shop = await supabase.from('shops').select('id').eq('tenant_id', tenantId).limit(1)
    const shopId = shop.data![0].id as string
    console.log(`E2E_TENANT=${tenantId}`)

    const ctx = { tenantId, shopId, userId, role: 'owner' as const, oversellPolicy: 'allow_and_flag' as const }
    const sctx = { tenantId, deviceName: 'e2e-phone' }
    const wipe = async () => {
      await Promise.all(db.tables.map((t) => t.clear()))
      store.set('stockcm.deviceId', newId())
    }
    await wipe()

    // ---- device A: product, customer, a split sale paid partly on credit
    const productId = await repo.addProduct(ctx, {
      name: 'Eau 1.5L', barcode: 'E2E-600123', baseUnit: 'bouteille', minStock: 6, taxRateBp: 0, isService: false,
      units: [
        { name: 'bouteille', factor: 1, sellPrice: 500, isBase: true },
        { name: 'carton', factor: 24, sellPrice: 11000, isBase: false },
      ],
      openingQty: 48, openingTotalCost: 24000,
    })
    const units = await db.units.where('productId').equals(productId).toArray()
    const bottle = units.find((u) => u.isBase)!
    const carton = units.find((u) => u.factor === 24)!
    const customer = await repo.addCustomer(ctx, 'Mme Tchoua', '677000111', 50000)
    const mk = (u: typeof bottle, qty: number) => ({
      productId, productName: 'Eau 1.5L', unitId: u.id, unitName: u.name, factor: u.factor, unitPrice: u.sellPrice,
      quantity: qty, lineDiscount: 0, taxRateBp: 0, isService: false,
    })
    const sale = await repo.checkout(ctx, {
      lines: [mk(bottle, 3), mk(carton, 1)], // 12,500
      payments: [{ method: 'cash', amount: 5000 }, { method: 'mtn_momo', amount: 2500 }, { method: 'credit', amount: 5000 }],
      customerId: customer.id,
    })

    const run1 = await engine.runSync(supabaseTransport, sctx, { manual: true })
    console.log('run1', JSON.stringify(run1))
    expect(run1.error).toBeUndefined()
    expect(await db.outbox.count()).toBe(0)

    const count = async (t: string) => (await supabase.from(t).select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)).count
    expect(await count('products')).toBe(1)
    expect(await count('product_units')).toBe(2)
    expect(await count('sales')).toBe(1)
    expect(await count('sale_lines')).toBe(2)
    expect(await count('financial_transactions')).toBe(2)
    expect(await count('customer_account_entries')).toBe(1)
    const serverStock = await supabase.from('stock_levels').select('quantity').eq('shop_id', shopId)
    expect(serverStock.data![0].quantity).toBe(48 - 27)

    // ---- replaying the exact same upload changes nothing (duplicate sync request)
    const replayOps = [
      { op_id: newId(), table: 'customers', payload: toServer('customers', customer as unknown as Record<string, unknown>) },
    ]
    const first = await supabaseTransport.push(store.get('stockcm.deviceId')!, replayOps)
    const again = await supabaseTransport.push(store.get('stockcm.deviceId')!, replayOps)
    expect(first.skipped).toBe(1) // customer already existed under another op id? no: same id, new op -> conflict-free skip below
    expect(again.skipped).toBe(1)

    // ---- device B: brand-new empty phone recovers everything
    const stockA = (await db.costs.get(`${shopId}:${productId}`))!
    await wipe()
    const run2 = await engine.runSync(supabaseTransport, sctx, { manual: true })
    console.log('run2', JSON.stringify(run2))
    expect(await db.products.count()).toBe(1)
    expect(await db.sales.count()).toBe(1)
    expect(await db.saleLines.count()).toBe(2)
    expect(await repo.customerBalance(customer.id)).toBe(5000)
    const stockB = (await db.costs.get(`${shopId}:${productId}`))!
    expect(stockB.quantity).toBe(stockA.quantity)
    expect(stockB.value).toBe(stockA.value)

    // ---- tampering: the server must refuse a sale whose total does not match its lines
    const sale2 = await repo.checkout(ctx, { lines: [mk(bottle, 2)], payments: [{ method: 'cash', amount: 1000 }] })
    const bad = await db.outbox.filter((o) => o.table === 'sales').first()
    await db.outbox.update(bad!.seq!, { payload: { ...(bad!.payload as object), total: 99999 } })
    await engine.runSync(supabaseTransport, sctx, { manual: true })
    const refused = await db.outbox.filter((o) => o.status === 'rejected').first()
    console.log('refused:', refused?.lastError)
    expect(refused).toBeTruthy()
    expect(refused!.lastError).toMatch(/do not match|add up|check/i)
    expect(await count('sales')).toBe(1) // nothing of the tampered sale reached the server
    expect(await count('sale_lines')).toBe(2)
    expect(sale.sale.id).not.toBe(sale2.sale.id)
  }, 120_000)
})
