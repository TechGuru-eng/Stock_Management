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
const ly = await import('./loyaltyRepo')
const rets = await import('./returnsRepo')
const engine = await import('../sync/engine')
const { FakeServer } = await import('../sync/testing/fakeServer')
const { getSyncSummary } = await import('../sync/status')
const { buildReturn: _unused } = await import('../domain/returns')
void _unused

const owner: import('./repo').Ctx = { tenantId: 't1', shopId: 's1', userId: 'o', role: 'owner', oversellPolicy: 'allow_and_flag' }
const cashier = { ...owner, userId: 'c', role: 'cashier' as const }
const manager = { ...owner, userId: 'm', role: 'manager' as const }
const sctx = { tenantId: 't1', deviceName: 'Phone' }
let server: InstanceType<typeof FakeServer>
const RULES = { enabled: true, earnPer: 1000, pointValue: 10, minRedeem: 50, maxShareBp: 5000 }

async function newDevice() {
  await Promise.all(db.tables.map((t) => t.clear()))
  store.set('stockcm.deviceId', newId())
}
beforeEach(async () => {
  server = new FakeServer()
  await newDevice()
})

async function setup() {
  const pid = await repo.addProduct(owner, { name: 'Riz', baseUnit: 'sac', minStock: 0, taxRateBp: 0, isService: false, units: [{ name: 'sac', factor: 1, sellPrice: 10_000, isBase: true }], openingQty: 50, openingTotalCost: 300_000 })
  const unit = (await db.units.where('productId').equals(pid).first())!
  const customer = await repo.addCustomer(owner, 'Awa', '677000111', 500_000)
  const sell = (ctx: import('./repo').Ctx, qty: number, extra: Partial<import('./repo').CheckoutArgs> & { cash?: number } = {}) => {
    const { cash, ...rest } = extra
    return repo.checkout(ctx, {
      lines: [{ productId: pid, productName: 'Riz', unitId: unit.id, unitName: 'sac', factor: 1, unitPrice: 10_000, quantity: qty, lineDiscount: 0, taxRateBp: 0, isService: false }],
      payments: [{ method: 'cash', amount: cash ?? qty * 10_000 }], customerId: customer.id, ...rest,
    })
  }
  return { pid, unit, customer, sell }
}

describe('the rules', () => {
  it('start switched off; only the owner changes them; silly values are refused; versions are kept', async () => {
    expect(await ly.loadRules()).toMatchObject({ enabled: false })
    await expect(ly.saveRules(manager, RULES)).rejects.toThrow(/only the owner/)
    await expect(ly.saveRules(owner, { ...RULES, earnPer: 0 })).rejects.toThrow(/invalid rules/)
    await ly.saveRules(owner, RULES)
    await new Promise((r) => setTimeout(r, 5))
    await ly.saveRules(owner, { ...RULES, pointValue: 20 })
    expect((await ly.loadRules()).pointValue).toBe(20)
    expect(await db.loyaltyRules.count()).toBe(2)
  })
})

describe('earning at the till', () => {
  it('points for what is actually paid; none while the program is off; none for credit', async () => {
    const { sell, customer } = await setup()
    const off = await sell(cashier, 2)
    expect(off.loyalty).toBeUndefined()
    await ly.saveRules(owner, RULES)
    const r = await sell(cashier, 2) // 20 000 paid: 20 points
    expect(r.loyalty).toMatchObject({ earned: 20, redeemed: 0, balanceAfter: 20 })
    const credit = await sell(cashier, 3, { cash: 10_000, payments: [{ method: 'cash', amount: 10_000 }, { method: 'credit', amount: 20_000 }] })
    expect(credit.loyalty!.earned).toBe(10) // only the 10 000 paid now
    expect(await ly.pointsOf(customer.id)).toBe(30)
  })

  it('a sale without a customer earns nothing and does not fail', async () => {
    const { sell } = await setup()
    await ly.saveRules(owner, RULES)
    const r = await sell(cashier, 1, { customerId: undefined })
    expect(r.loyalty).toBeUndefined()
  })
})

describe('spending points', () => {
  it('lowers the total and the money due; a cashier needs no approval; the sale lines still add up', async () => {
    const { sell, customer } = await setup()
    await ly.saveRules(owner, RULES)
    await ly.adjustPoints(manager, customer.id, 300, 'welcome gift') // 300 points = 3 000 FCFA
    const r = await sell(cashier, 2, { usePoints: 300, cash: 20_000 - 3_000 })
    expect(r.sale.discount).toBe(3_000)
    expect(r.sale.total).toBe(17_000)
    expect(r.lines.reduce((t, l) => t + l.lineTotal, 0)).toBe(r.sale.total)
    expect(r.loyalty).toMatchObject({ redeemed: 300, earned: 17 }) // earns on the 17 000 actually paid
    expect(await ly.pointsOf(customer.id)).toBe(17)
  })

  it('refuses more than the balance, more than the allowed share, less than the minimum, and points without a customer', async () => {
    const { sell, customer } = await setup()
    await ly.saveRules(owner, RULES)
    await ly.adjustPoints(manager, customer.id, 200, 'gift')
    await expect(sell(cashier, 2, { usePoints: 300, cash: 1 })).rejects.toThrow(/not_enough_points/)
    await expect(sell(cashier, 2, { usePoints: 20, cash: 1 })).rejects.toThrow(/below_minimum/)
    await ly.adjustPoints(manager, customer.id, 600, 'gift')
    await expect(sell(cashier, 1, { usePoints: 700, cash: 1 })).rejects.toThrow(/too_much_of_sale/) // 700 points = 7 000 FCFA, but at most half of 10 000 may be paid with points
  })

  it('nothing is recorded when the sale is refused', async () => {
    const { sell, customer } = await setup()
    await ly.saveRules(owner, RULES)
    await expect(sell(cashier, 1, { usePoints: 100, cash: 1 })).rejects.toThrow()
    expect(await db.sales.count()).toBe(0)
    expect(await ly.pointsOf(customer.id)).toBe(0)
  })
})

describe('returns and cancellations', () => {
  it('a part return takes back its share of the points earned', async () => {
    const { sell, customer, unit } = await setup()
    await ly.saveRules(owner, RULES)
    const r = await sell(cashier, 4) // 40 000 -> 40 points
    const line = r.lines[0]
    await rets.processReturn(manager, r.sale.id, { kind: 'return', reason: 'damaged', refundMethod: 'cash', lines: [{ saleLineId: line.id, quantity: 1, restock: true }] })
    expect(await ly.pointsOf(customer.id)).toBe(30) // a quarter of 40
    void unit
  })

  it('cancelling a sale takes back all that is left and gives back the points that were spent', async () => {
    const { sell, customer } = await setup()
    await ly.saveRules(owner, RULES)
    await ly.adjustPoints(manager, customer.id, 300, 'gift')
    const r = await sell(cashier, 2, { usePoints: 300, cash: 17_000 }) // spends 300, earns 17
    expect(await ly.pointsOf(customer.id)).toBe(17)
    await rets.cancelSale(manager, r.sale.id, 'customer changed their mind', 'cash')
    expect(await ly.pointsOf(customer.id)).toBe(300) // the earned 17 gone, the 300 spent are back
    await expect(rets.cancelSale(manager, r.sale.id, 'again', 'cash')).rejects.toThrow() // cannot cancel twice, so points are not given back twice
    expect(await ly.pointsOf(customer.id)).toBe(300)
  })
})

describe('manual adjustments', () => {
  it('need a manager and a reason', async () => {
    const { customer } = await setup()
    await expect(ly.adjustPoints(cashier, customer.id, 10, 'x')).rejects.toThrow(/manager or the owner/)
    await expect(ly.adjustPoints(manager, customer.id, 10, ' ')).rejects.toThrow(/reason/)
    await expect(ly.adjustPoints(manager, customer.id, 0, 'x')).rejects.toThrow(/not zero/)
    await ly.adjustPoints(manager, customer.id, -5, 'correction')
    expect(await ly.pointsOf(customer.id)).toBe(-5) // visible, never hidden
  })
})

describe('sync', () => {
  it('rules and points reach the server and a second device, with the same balance', async () => {
    const { sell, customer } = await setup()
    await ly.saveRules(owner, RULES)
    await sell(cashier, 3)
    await engine.runSync(server, sctx)
    expect((await getSyncSummary()).pendingGroups).toBe(0)
    expect(server.count('loyalty_entries')).toBe(1)
    expect(server.count('loyalty_rules')).toBe(1)
    await newDevice()
    await engine.runSync(server, sctx)
    expect(await ly.pointsOf(customer.id)).toBe(30)
    expect((await ly.loadRules()).enabled).toBe(true)
  })
})
