import { describe, expect, it } from 'vitest'
import { daysUntil, expiredQuantity, expiryRows, goodQuantity, remainingBatches, statusOf, summarizeExpiry, validExpiry, type BatchRecord } from './expiry'

const today = new Date(2026, 10, 18) // 18 Nov 2026 (local)
const b = (id: string, expiry: string, quantity: number, at = '01'): BatchRecord => ({ id, tenantId: 't', shopId: 's', productId: 'milk', expiry, quantity, receivedAt: `2026-11-${at}T00:00:00Z`, recordedBy: 'u' })

describe('days and status', () => {
  it('counts whole calendar days, and today is not yet expired', () => {
    expect(daysUntil('2026-11-18', today)).toBe(0)
    expect(daysUntil('2026-11-25', today)).toBe(7)
    expect(daysUntil('2026-11-17', today)).toBe(-1)
    expect(daysUntil('2027-01-01', today)).toBe(44)
  })
  it('expired / soon / ok / undated', () => {
    expect(statusOf('2026-11-17', today, 30)).toBe('expired')
    expect(statusOf('2026-11-18', today, 30)).toBe('soon')
    expect(statusOf('2026-12-18', today, 30)).toBe('soon') // exactly 30 days
    expect(statusOf('2026-12-19', today, 30)).toBe('ok')
    expect(statusOf(null, today, 30)).toBe('undated')
  })
})

describe('what is left of each batch (oldest goes first)', () => {
  it('sales come off the earliest expiry first', () => {
    const batches = [b('b1', '2026-11-20', 10), b('b2', '2026-12-31', 20)]
    expect(remainingBatches(30, batches)).toEqual([{ id: 'b1', expiry: '2026-11-20', quantity: 10 }, { id: 'b2', expiry: '2026-12-31', quantity: 20 }])
    expect(remainingBatches(22, batches)).toEqual([{ id: 'b1', expiry: '2026-11-20', quantity: 2 }, { id: 'b2', expiry: '2026-12-31', quantity: 20 }])
    expect(remainingBatches(15, batches)).toEqual([{ id: 'b2', expiry: '2026-12-31', quantity: 15 }]) // the first batch is gone
    expect(remainingBatches(0, batches)).toEqual([])
  })
  it('batch order does not depend on arrival order', () => {
    const a = remainingBatches(25, [b('b2', '2026-12-31', 20), b('b1', '2026-11-20', 10)])
    expect(a).toEqual(remainingBatches(25, [b('b1', '2026-11-20', 10), b('b2', '2026-12-31', 20)]))
  })
  it('stock above what dated batches explain is undated and assumed oldest', () => {
    // 50 on the shelf, only 20 carry a date: the 30 undated are used first
    expect(remainingBatches(50, [b('b1', '2026-12-31', 20)])).toEqual([{ id: null, expiry: null, quantity: 30 }, { id: 'b1', expiry: '2026-12-31', quantity: 20 }])
    expect(remainingBatches(18, [b('b1', '2026-12-31', 20)])).toEqual([{ id: 'b1', expiry: '2026-12-31', quantity: 18 }])
  })
  it('negative stock is an empty shelf', () => {
    expect(remainingBatches(-3, [b('b1', '2026-12-31', 20)])).toEqual([])
  })
})

describe('what is expired or about to be', () => {
  const products = [
    { id: 'milk', name: 'Lait', baseUnit: 'boîte', trackExpiry: true, active: true, onHand: 18, avgCost: 400 },
    { id: 'rice', name: 'Riz', baseUnit: 'kg', trackExpiry: false, active: true, onHand: 50, avgCost: 600 },
  ]
  const batches = [b('b1', '2026-11-10', 10), b('b2', '2026-11-25', 6), b('b3', '2027-03-01', 20)]
  it('lists expired and expiring batches with their value, soonest first, only for products that track dates', () => {
    // 18 on the shelf: the newest batch (20) explains it all, so nothing else is left
    expect(expiryRows(products, batches, today, 30)).toEqual([])
    const more = expiryRows([{ ...products[0], onHand: 36 }], batches, today, 30)
    expect(more.map((r) => [r.batchId, r.status, r.quantity, r.daysLeft, r.value])).toEqual([['b1', 'expired', 10, -8, 4000], ['b2', 'soon', 6, 7, 2400]])
  })
  it('summarises units and value', () => {
    const rows = expiryRows([{ ...products[0], onHand: 36 }], batches, today, 30)
    expect(summarizeExpiry(rows)).toEqual({ expiredUnits: 10, expiredValue: 4000, soonUnits: 6, soonValue: 2400, products: 1 })
  })
  it('hidden products and products that do not track dates are ignored', () => {
    expect(expiryRows([{ ...products[0], active: false, onHand: 36 }, { ...products[1], onHand: 99 }], batches, today, 30)).toEqual([])
  })
})

describe('write-off and selling', () => {
  const batches = [b('b1', '2026-11-10', 10), b('b2', '2026-12-31', 20)]
  it('knows how many units are expired (what a write-off removes) and how many are still good', () => {
    expect(expiredQuantity(30, batches, today)).toBe(10)
    expect(goodQuantity(30, batches, today)).toBe(20)
    expect(expiredQuantity(20, batches, today)).toBe(0) // the expired batch has already been used up
    expect(goodQuantity(45, batches, today)).toBe(35) // 45 on the shelf: 15 undated (counted as good) + 10 expired + 20 good
  })
})

describe('typed dates', () => {
  it('accepts real dates in a sensible range, refuses the rest', () => {
    for (const ok of ['2026-11-18', '2027-12-31', '2026-02-28']) expect(validExpiry(ok, today)).toBe(true)
    for (const bad of ['', '18/11/2026', '2026-13-01', '2026-02-30', '2026-11-1', '1999-01-01', '2099-01-01']) expect(validExpiry(bad, today), bad).toBe(false)
  })
})
