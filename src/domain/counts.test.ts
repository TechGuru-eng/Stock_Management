import { describe, expect, it } from 'vitest'
import { adjustmentsFor, countStatus, isFlagged, latestLines, summarizeCount, validCountedQty, varianceRows, type CountLineRecord } from './counts'

const line = (id: string, productId: string, counted: number, expected: number, unitCost: number, at: string): CountLineRecord => ({
  id, tenantId: 't', countId: 'c1', productId, counted, expected, unitCost, countedBy: 'u', countedAt: `2026-11-18T${at}:00.000Z`,
})
const names = new Map([['water', 'Eau'], ['rice', 'Riz'], ['oil', 'Huile']])

describe('recounting', () => {
  it('the newest line for a product wins; the earlier one is kept, not edited', () => {
    const first = line('l1', 'water', 10, 12, 300, '09:00')
    const second = line('l2', 'water', 12, 12, 300, '09:30')
    expect(latestLines([first, second])).toEqual([second])
    expect(latestLines([second, first])).toEqual([second]) // order of arrival does not matter
  })
  it('ties on the same instant are settled the same way on every device', () => {
    const a = line('a', 'water', 1, 1, 1, '09:00')
    const b = line('b', 'water', 2, 1, 1, '09:00')
    expect(latestLines([a, b])).toEqual(latestLines([b, a]))
  })
})

describe('variances', () => {
  const lines = [
    line('l1', 'water', 36, 40, 300, '09:00'), // 4 missing = -1200
    line('l2', 'rice', 52, 50, 700, '09:05'), // 2 extra = +1400
    line('l3', 'oil', 20, 20, 1200, '09:10'), // matches
  ]
  const rows = varianceRows(lines, names)
  it('measures counted minus expected and values it at the cost of that moment, biggest value first', () => {
    expect(rows.map((r) => [r.name, r.diff, r.value])).toEqual([['Riz', 2, 1400], ['Eau', -4, -1200], ['Huile', 0, 0]])
  })
  it('summarises what is missing, what is extra and how accurate the count was', () => {
    const s = summarizeCount(rows)
    expect(s).toMatchObject({ counted: 3, withDifference: 2, matching: 1, surplusValue: 1400, shortageValue: 1200, netValue: 200, accuracyBp: 3333 })
  })
  it('approving posts only the differences, for the difference only', () => {
    expect(adjustmentsFor(rows)).toEqual([{ productId: 'rice', qty: 2 }, { productId: 'water', qty: -4 }])
  })
  it('an empty count has nothing to summarise', () => {
    expect(summarizeCount([])).toMatchObject({ counted: 0, accuracyBp: null, netValue: 0 })
  })
})

describe('what deserves a second look', () => {
  it('flags a big share or a big value, never a perfect match', () => {
    expect(isFlagged(100, 0, 0)).toBe(false)
    expect(isFlagged(100, -10, -100)).toBe(true) // 10% of the stock
    expect(isFlagged(1000, -5, -9000)).toBe(false) // small share, small value
    expect(isFlagged(1000, -5, -10000)).toBe(true) // small share but worth 10 000
    expect(isFlagged(0, 3, 300)).toBe(true) // nothing expected, something found
    expect(isFlagged(-2, 5, 100)).toBe(true) // system was negative (oversold)
  })
})

describe('input rules and status', () => {
  it('only whole non-negative numbers can be counted', () => {
    for (const n of [0, 1, 250]) expect(validCountedQty(n)).toBe(true)
    for (const n of [-1, 1.5, NaN, Infinity, 2e9]) expect(validCountedQty(n)).toBe(false)
  })
  it('a count is open until someone decides', () => {
    expect(countStatus(undefined)).toBe('open')
    expect(countStatus({ id: 'd', tenantId: 't', countId: 'c1', decision: 'approved', decidedBy: 'u', decidedAt: '' })).toBe('approved')
  })
})
