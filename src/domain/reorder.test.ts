import { describe, expect, it } from 'vitest'
import type { SaleLineRecord, SaleRecord } from './pos'
import type { ReturnLineRecord, ReturnRecord } from './returns'
import { DEFAULT_REORDER, chooseSuppliers, groupBySupplier, onOrder, orderMessage, roundUpToPack, salesSpeed, suggestReorders, type ProductForReorder } from './reorder'
import type { SupplierPriceRecord } from './supplierPrices'

const day = (d: string) => `2026-11-${d}T10:00:00.000Z`
const sale = (id: string, shopId: string, d: string): SaleRecord => ({ id, tenantId: 't', shopId, saleNumber: id, cashierId: 'u', deviceId: 'd', subtotal: 0, discount: 0, tax: 0, total: 0, collected: 0, outstanding: 0, status: 'completed', occurredAt: day(d) })
const line = (saleId: string, productId: string, base: number): SaleLineRecord => ({ id: `${saleId}-${productId}`, tenantId: 't', saleId, productId, productName: productId, unitId: 'u', unitName: 'u', quantity: base, baseQuantity: base, unitPrice: 1, lineDiscount: 0, lineTotal: 0, costOfGoods: 0 })

describe('how fast things sell', () => {
  const sales = [sale('s1', 'A', '05'), sale('s2', 'A', '20'), sale('s3', 'B', '10'), sale('old', 'A', '01')]
  const lines = [line('s1', 'water', 30), line('s2', 'water', 30), line('s2', 'rice', 3), line('s3', 'water', 999), line('old', 'water', 500)]
  it('base units per day for this shop and period only', () => {
    const sp = salesSpeed({ sales, lines, shopId: 'A', from: day('02'), to: day('30'), windowDays: 30 })
    expect(sp.get('water')).toBe(2) // 60 over 30 days; the other shop's and the old sale are not counted
    expect(sp.get('rice')).toBeCloseTo(0.1)
  })
  it('customer returns come off', () => {
    const returns = [{ id: 'r1', shopId: 'A', occurredAt: day('21') } as ReturnRecord]
    const returnLines = [{ returnId: 'r1', productId: 'water', baseQuantity: 15 } as ReturnLineRecord]
    expect(salesSpeed({ sales, lines, returns, returnLines, shopId: 'A', from: day('02'), to: day('30'), windowDays: 30 }).get('water')).toBe(1.5)
  })
  it('a product with no net sales has no speed', () => {
    const returns = [{ id: 'r1', shopId: 'A', occurredAt: day('21') } as ReturnRecord]
    const returnLines = [{ returnId: 'r1', productId: 'rice', baseQuantity: 3 } as ReturnLineRecord]
    expect(salesSpeed({ sales, lines, returns, returnLines, shopId: 'A', from: day('02'), to: day('30'), windowDays: 30 }).has('rice')).toBe(false)
  })
})

describe('what is already on order', () => {
  it('ordered minus delivered, per product, this shop only', () => {
    const purchases = [{ id: 'po1', shopId: 'A' }, { id: 'po2', shopId: 'A' }, { id: 'po3', shopId: 'B' }]
    const lines = [
      { id: 'l1', purchaseId: 'po1', productId: 'water', baseQuantity: 48 },
      { id: 'l2', purchaseId: 'po2', productId: 'water', baseQuantity: 24 },
      { id: 'l3', purchaseId: 'po3', productId: 'water', baseQuantity: 999 },
      { id: 'l4', purchaseId: 'po1', productId: 'rice', baseQuantity: 10 },
    ]
    const received = [{ purchaseLineId: 'l1', baseQuantity: 30 }, { purchaseLineId: 'l4', baseQuantity: 10 }]
    const o = onOrder('A', purchases, lines, received)
    expect(o.get('water')).toBe(18 + 24)
    expect(o.has('rice')).toBe(false) // fully delivered
  })
})

const P = (id: string, over: Partial<ProductForReorder> = {}): ProductForReorder => ({ id, name: id, minStock: 0, isService: false, active: true, packFactor: 1, baseUnit: 'piece', ...over })
const run = (products: ProductForReorder[], onHand: Record<string, number>, speed: Record<string, number>, incoming: Record<string, number> = {}, s = DEFAULT_REORDER) =>
  suggestReorders(products, new Map(Object.entries(onHand)), new Map(Object.entries(speed)), new Map(Object.entries(incoming)), s)

describe('what to order', () => {
  it('covers the chosen number of days of sales, minus what is there and what is coming', () => {
    const r = run([P('water')], { water: 10 }, { water: 2 }, { water: 6 }) // target 28, have 10, coming 6 -> 12
    expect(r[0]).toMatchObject({ productId: 'water', qty: 12, daysLeft: 5, urgency: 'urgent' })
  })
  it('keeps the minimum stock on top of the cover', () => {
    expect(run([P('water', { minStock: 6 })], { water: 10 }, { water: 2 })[0].qty).toBe(24) // 28 + 6 - 10
  })
  it('rounds up to whole cartons when the product has one', () => {
    const r = run([P('water', { packFactor: 24, packName: 'carton' })], { water: 10 }, { water: 2 })
    expect(r[0]).toMatchObject({ qty: 24, packs: 1, packName: 'carton' }) // need 18 -> one carton
    expect(run([P('water', { packFactor: 24, packName: 'carton' })], { water: 10 }, { water: 2 }, {}, { ...DEFAULT_REORDER, roundToPack: false })[0]).toMatchObject({ qty: 18, packs: null })
    expect(roundUpToPack(25, 24)).toBe(48)
    expect(roundUpToPack(24, 24)).toBe(24)
    expect(roundUpToPack(5, 1)).toBe(5)
  })
  it('nothing to order when stock plus incoming already covers it', () => {
    expect(run([P('water')], { water: 40 }, { water: 2 })).toEqual([])
    expect(run([P('water')], { water: 10 }, { water: 2 }, { water: 18 })).toEqual([])
  })
  it('services, hidden products and products that do not sell are left out (unless below their minimum)', () => {
    expect(run([P('svc', { isService: true }), P('old', { active: false }), P('dead')], { svc: 0, old: 0, dead: 0 }, { svc: 5, old: 5 })).toEqual([])
    const low = run([P('dead', { minStock: 5 })], { dead: 2 }, {})
    expect(low[0]).toMatchObject({ qty: 3, urgency: 'low', daysLeft: null })
    expect(run([P('dead', { minStock: 5 })], { dead: 2 }, {}, { dead: 3 })).toEqual([]) // an order is already coming
  })
  it('ranks out of stock first, then urgent, soon, low', () => {
    const r = run([P('c'), P('b'), P('a'), P('d', { minStock: 10 })], { a: 0, b: 6, c: 10, d: 8 }, { a: 1, b: 1, c: 1 })
    expect(r.map((x) => [x.productId, x.urgency])).toEqual([['a', 'out'], ['b', 'urgent'], ['c', 'soon'], ['d', 'low']])
  })
  it('negative stock (oversold) is treated as nothing on the shelf', () => {
    expect(run([P('water')], { water: -3 }, { water: 1 })[0]).toMatchObject({ urgency: 'out', daysLeft: 0, qty: 17 })
  })
})

describe('who to order from', () => {
  const quote = (id: string, supplierId: string, productId: string, unitId: string, price: number): SupplierPriceRecord => ({ id, tenantId: 't', supplierId, productId, unitId, price, source: 'manual', recordedBy: 'u', recordedAt: day('01') })
  const units = new Map([['bottle', { name: 'bouteille', factor: 1 }], ['carton', { name: 'carton', factor: 24 }]])
  const suggestion = run([P('water'), P('rice'), P('oil')], { water: 0, rice: 0, oil: 0 }, { water: 1, rice: 1, oil: 1 })
  const avg = new Map([['oil', 1100]])

  it('cheapest quote per base unit wins; else the supplier last bought from; else the average cost as an estimate', () => {
    const prices = [quote('1', 's1', 'water', 'carton', 7200), quote('2', 's2', 'water', 'carton', 6000)]
    const paid = new Map([['s3|rice', { baseCost: 700, at: day('02') }], ['s1|rice', { baseCost: 750, at: day('01') }]])
    const out = chooseSuppliers(suggestion, prices, units, paid, avg)
    const by = (id: string) => out.find((o) => o.productId === id)!
    expect(by('water')).toMatchObject({ supplierId: 's2', unitCost: 250, costSource: 'quote', estimate: 14 * 250 })
    expect(by('rice')).toMatchObject({ supplierId: 's3', unitCost: 700, costSource: 'last_paid' })
    expect(by('oil')).toMatchObject({ supplierId: null, unitCost: 1100, costSource: 'average' })
  })
  it('no price anywhere: no estimate, never invented', () => {
    expect(chooseSuppliers(run([P('x')], { x: 0 }, { x: 1 }), [], units, new Map(), new Map())[0]).toMatchObject({ supplierId: null, unitCost: null, estimate: null })
  })
  it('groups by supplier, the unsourced rows last, with the estimate of each order', () => {
    const prices = [quote('1', 's1', 'water', 'bottle', 250), quote('2', 's2', 'rice', 'bottle', 700)]
    const groups = groupBySupplier(chooseSuppliers(suggestion, prices, units, new Map(), avg))
    expect(groups.map((g) => [g.supplierId, g.rows.map((r) => r.productId)])).toEqual([['s2', ['rice']], ['s1', ['water']], [null, ['oil']]]) // equally urgent: the bigger order first
    expect(groups[1].estimate).toBe(14 * 250)
  })
})

describe('the order message', () => {
  it('lists quantities, in packs when there are packs, in the right language', () => {
    const lines = [{ name: 'Eau 1.5L', qty: 48, baseUnit: 'bouteille', packs: 2, packName: 'carton' }, { name: 'Riz', qty: 10, baseUnit: 'kg' }]
    expect(orderMessage('fr', 'Boutique Mbarga', lines)).toBe('Bonjour, commande de Boutique Mbarga :\n- Eau 1.5L : 2 carton\n- Riz : 10 kg\nMerci de confirmer la disponibilité et le prix.')
    expect(orderMessage('en', 'Shop', lines.slice(1))).toContain('- Riz : 10 kg')
  })
})
