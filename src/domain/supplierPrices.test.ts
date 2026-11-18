import { describe, expect, it } from 'vitest'
import { bestSuppliers, changeBp, costWarning, currentQuotes, isStale, lastPaid, perBaseUnit, quoteHistory, suggestedTotal, type SupplierPriceRecord } from './supplierPrices'

const q = (id: string, supplierId: string, productId: string, unitId: string, price: number, at: string): SupplierPriceRecord => ({
  id, tenantId: 't', supplierId, productId, unitId, price, source: 'manual', recordedBy: 'u', recordedAt: `2026-11-${at}T10:00:00.000Z`,
})
const units = new Map([['bottle', { name: 'bouteille', factor: 1 }], ['carton', { name: 'carton', factor: 24 }]])

describe('quotes over time', () => {
  const recs = [q('a', 's1', 'water', 'carton', 7000, '01'), q('b', 's1', 'water', 'carton', 7200, '10'), q('c', 's2', 'water', 'carton', 6900, '05')]
  it('the newest quote is the current one; the history keeps the old ones', () => {
    const cur = currentQuotes(recs)
    expect(cur.get('s1|water|carton')!.price).toBe(7200)
    expect(cur.size).toBe(2)
    expect(quoteHistory(recs, { supplierId: 's1', productId: 'water', unitId: 'carton' }).map((r) => r.price)).toEqual([7200, 7000])
  })
  it('arrival order does not matter, and ties are settled the same way everywhere', () => {
    expect(currentQuotes([...recs].reverse()).get('s1|water|carton')!.price).toBe(7200)
    const x = q('x', 's1', 'p', 'u', 1, '01')
    const y = q('y', 's1', 'p', 'u', 2, '01')
    expect(currentQuotes([x, y]).get('s1|p|u')!.price).toBe(currentQuotes([y, x]).get('s1|p|u')!.price)
  })
})

describe('how much a price moved', () => {
  it('in basis points of the old price; nothing to compare gives null', () => {
    expect(changeBp(7000, 7350)).toBe(500)
    expect(changeBp(7000, 6300)).toBe(-1000)
    expect(changeBp(7000, 7000)).toBe(0)
    expect(changeBp(null, 100)).toBeNull()
    expect(changeBp(0, 100)).toBeNull()
  })
})

describe('comparing suppliers', () => {
  it('compares per base unit, so a carton and a bottle are comparable, and ranks cheapest first', () => {
    const recs = [q('1', 's1', 'water', 'carton', 7200, '01'), q('2', 's2', 'water', 'bottle', 280, '02'), q('3', 's3', 'water', 'carton', 6000, '03'), q('4', 's4', 'rice', 'bottle', 1, '03')]
    const r = bestSuppliers('water', currentQuotes(recs), units)
    expect(r.rows.map((x) => [x.supplierId, x.perBase])).toEqual([['s3', 250], ['s2', 280], ['s1', 300]])
    expect(r.cheapestSupplierId).toBe('s3')
    expect(r.cheapestSavingBp).toBe(-1667) // 250 vs 300: 16.7% cheaper than the dearest
    expect(perBaseUnit(7000, 24)).toBe(292)
  })
  it('one supplier quoting two units counts once, with their cheapest', () => {
    const recs = [q('1', 's1', 'water', 'carton', 7200, '01'), q('2', 's1', 'water', 'bottle', 250, '02')]
    expect(bestSuppliers('water', currentQuotes(recs), units).rows).toHaveLength(1)
    expect(bestSuppliers('water', currentQuotes(recs), units).rows[0].unitName).toBe('bouteille')
  })
  it('no quotes: nothing', () => {
    expect(bestSuppliers('water', new Map(), units)).toEqual({ rows: [], cheapestSupplierId: null, cheapestSavingBp: null })
  })
})

describe('what was really paid', () => {
  it('cost per base unit of the latest delivery, per supplier and product (part deliveries priced by their share)', () => {
    const purchases = [{ id: 'po1', supplierId: 's1' }, { id: 'po2', supplierId: 's1' }, { id: 'po3', supplierId: 's2' }]
    const receipts = [
      { id: 'r1', purchaseId: 'po1', receivedAt: '2026-10-01T00:00:00Z' },
      { id: 'r2', purchaseId: 'po2', receivedAt: '2026-11-01T00:00:00Z' },
      { id: 'r3', purchaseId: 'po3', receivedAt: '2026-11-02T00:00:00Z' },
    ]
    const lines = [
      { receiptId: 'r1', productId: 'water', baseQuantity: 48, totalCost: 14400 },
      { receiptId: 'r2', productId: 'water', baseQuantity: 24, totalCost: 7200 },
      { receiptId: 'r3', productId: 'water', baseQuantity: 24, totalCost: 6000 },
      { receiptId: 'rX', productId: 'water', baseQuantity: 5, totalCost: 5 },
    ]
    const p = lastPaid(purchases, receipts, lines)
    expect(p.get('s1|water')).toEqual({ baseCost: 300, at: '2026-11-01T00:00:00Z' })
    expect(p.get('s2|water')!.baseCost).toBe(250)
    expect(p.size).toBe(2)
  })
})

describe('warnings when typing an order', () => {
  it('flags a cost clearly above the quote or the last price paid', () => {
    expect(costWarning(300, 300, 300)).toBeNull()
    expect(costWarning(314, 300, null)).toBeNull() // 4.7% over: fine
    expect(costWarning(316, 300, null)).toBe('above_quote')
    expect(costWarning(332, null, 300)).toBe('above_last_paid')
    expect(costWarning(320, null, 300)).toBeNull() // 6.7% over the last paid: allowed
    expect(costWarning(100, 300, 300)).toBeNull() // cheaper is never a warning
    expect(costWarning(999, null, null)).toBeNull()
  })
  it('suggests a total from the quote', () => {
    expect(suggestedTotal(7200, 3)).toBe(21600)
    expect(suggestedTotal(250, 2.5)).toBe(625)
  })
  it('knows when a quote has gone stale', () => {
    expect(isStale('2026-07-01T00:00:00Z', new Date('2026-11-18T00:00:00Z'))).toBe(true)
    expect(isStale('2026-10-01T00:00:00Z', new Date('2026-11-18T00:00:00Z'))).toBe(false)
  })
})
