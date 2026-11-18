import { describe, expect, it } from 'vitest'
import { buildSale, cartTotals, type CartLine } from './pos'
import { emptyCostState } from './costing'
import { DEFAULT_LOYALTY, balanceOf, checkRedeem, maxRedeemPoints, pointsEarned, redeemValue, reversalPoints, rewardRateBp, splitDiscount, statement, validateRules, type LoyaltyEntry, type LoyaltyRules } from './loyalty'

const rules: LoyaltyRules = { ...DEFAULT_LOYALTY, enabled: true } // 1 point per 1 000 FCFA, 1 point = 10 FCFA, min 50, up to half

describe('earning', () => {
  it('one point for each full block of spending actually paid; nothing when the program is off', () => {
    expect(pointsEarned(25_000, rules)).toBe(25)
    expect(pointsEarned(999, rules)).toBe(0)
    expect(pointsEarned(1_999, rules)).toBe(1)
    expect(pointsEarned(0, rules)).toBe(0)
    expect(pointsEarned(25_000, DEFAULT_LOYALTY)).toBe(0)
  })
  it('tells the owner what the rules cost: 10 FCFA back per 1 000 spent is 1%', () => {
    expect(rewardRateBp(rules)).toBe(100)
    expect(rewardRateBp({ ...rules, earnPer: 500, pointValue: 25 })).toBe(500)
  })
})

describe('redeeming', () => {
  it('limited by the balance, the share of the sale and the minimum', () => {
    expect(maxRedeemPoints(500, 10_000, rules)).toBe(500) // half of 10 000 = 5 000 FCFA = 500 points
    expect(maxRedeemPoints(120, 10_000, rules)).toBe(120) // only has 120
    expect(maxRedeemPoints(500, 4_000, rules)).toBe(200) // half of 4 000 = 2 000 FCFA = 200 points
    expect(maxRedeemPoints(40, 10_000, rules)).toBe(0) // below the minimum of 50
    expect(maxRedeemPoints(500, 600, rules)).toBe(0) // 300 FCFA = 30 points < minimum
    expect(maxRedeemPoints(500, 10_000, DEFAULT_LOYALTY)).toBe(0)
    expect(redeemValue(120, rules)).toBe(1200)
  })
  it('checks a chosen amount and says what is wrong', () => {
    expect(checkRedeem(100, 500, 10_000, rules)).toBeNull()
    expect(checkRedeem(600, 500, 10_000, rules)).toBe('not_enough_points')
    expect(checkRedeem(20, 500, 10_000, rules)).toBe('below_minimum')
    expect(checkRedeem(600, 900, 10_000, rules)).toBe('too_much_of_sale')
    expect(checkRedeem(1.5, 500, 10_000, rules)).toBe('not_whole')
    expect(checkRedeem(100, 500, 10_000, DEFAULT_LOYALTY)).toBe('disabled')
  })
})

describe('spreading the discount over the lines', () => {
  it('adds up exactly and never exceeds a line', () => {
    const parts = splitDiscount(1000, [3333, 3333, 3334])
    expect(parts.reduce((t, n) => t + n, 0)).toBe(1000)
    expect(parts.every((p, i) => p <= [3333, 3333, 3334][i])).toBe(true)
    expect(splitDiscount(5, [1, 1])).toEqual([1, 1]) // capped by the lines
    expect(splitDiscount(0, [100, 200])).toEqual([0, 0])
    expect(splitDiscount(10_000, [100, 200])).toEqual([100, 200]) // cannot exceed what the lines cost
    expect(splitDiscount(100, [])).toEqual([])
  })
  it('is proportional', () => {
    expect(splitDiscount(300, [1000, 2000])).toEqual([100, 200])
  })
})

describe('a sale with points goes through the real sale builder', () => {
  const lines: CartLine[] = [
    { productId: 'a', productName: 'A', unitId: 'u', unitName: 'p', factor: 1, unitPrice: 5000, quantity: 1, lineDiscount: 0, taxRateBp: 1925, isService: false },
    { productId: 'b', productName: 'B', unitId: 'u2', unitName: 'p', factor: 1, unitPrice: 2500, quantity: 2, lineDiscount: 0, taxRateBp: 0, isService: false },
  ]
  const input = (extra: Partial<Parameters<typeof buildSale>[0]> = {}) => {
    let n = 0
    return {
      newId: () => `id${++n}`, tenantId: 't', shopId: 's', userId: 'u', deviceId: 'd', role: 'cashier' as const, saleNumber: 'S1', nowIso: '2026-11-18T10:00:00Z',
      lines, payments: [{ method: 'cash' as const, amount: 0 }], costStates: { a: { ...emptyCostState, quantity: 10, value: 5000 }, b: { ...emptyCostState, quantity: 10, value: 5000 } }, oversellPolicy: 'allow_and_flag' as const, ...extra,
    }
  }
  const withDisc = (d: number[]) => cartTotals(lines.map((l, i) => ({ ...l, lineDiscount: l.lineDiscount + d[i] })))
  it('points lower the total; a cashier needs no approval for them; the lines keep adding up', () => {
    const net = 5000 + 5000
    const pts = maxRedeemPoints(900, net, rules) // up to half = 5 000 FCFA = 500 points
    const disc = splitDiscount(redeemValue(pts, rules), [5000, 5000])
    const sale = buildSale(input({ loyaltyDiscounts: disc, payments: [{ method: 'cash', amount: withDisc(disc).total }] }))
    expect(pts).toBe(500)
    expect(sale.sale.discount).toBe(5000)
    expect(sale.sale.total).toBe(withDisc(disc).total)
    expect(sale.lines.map((l) => l.lineDiscount)).toEqual(disc)
    expect(sale.lines.reduce((t, l) => t + l.lineTotal, 0)).toBe(sale.sale.total) // lines add up to the sale
  })
  it("a manual discount above a cashier's limit still needs approval; points do not count towards it", () => {
    const big = lines.map((l, i) => (i === 0 ? { ...l, lineDiscount: 2000 } : l)) // 40% manual
    expect(() => buildSale(input({ lines: big, payments: [{ method: 'cash', amount: 1 }] }))).toThrow(/approval/)
    const d = [2500, 2500]
    expect(() => buildSale(input({ loyaltyDiscounts: d, payments: [{ method: 'cash', amount: withDisc(d).total }] }))).not.toThrow() // 50% by points: fine
  })
})

describe('taking points back', () => {
  it('a part return takes back its share; a cancellation takes back what is left', () => {
    expect(reversalPoints({ earned: 100, alreadyReversed: 0, returnedValue: 2500, saleTotal: 10_000, cancellation: false })).toBe(25)
    expect(reversalPoints({ earned: 100, alreadyReversed: 25, returnedValue: 10_000, saleTotal: 10_000, cancellation: false })).toBe(75) // never more than is left
    expect(reversalPoints({ earned: 100, alreadyReversed: 25, returnedValue: 0, saleTotal: 10_000, cancellation: true })).toBe(75)
    expect(reversalPoints({ earned: 0, alreadyReversed: 0, returnedValue: 100, saleTotal: 100, cancellation: false })).toBe(0)
  })
})

describe('the ledger', () => {
  const e = (id: string, points: number, kind: LoyaltyEntry['kind'], at: string): LoyaltyEntry => ({ id, tenantId: 't', customerId: 'c', points, kind, createdBy: 'u', occurredAt: `2026-11-${at}T10:00:00Z` })
  it('balance is the sum; the statement shows the running balance, oldest first', () => {
    const ents = [e('3', -50, 'redeem', '12'), e('1', 120, 'earn', '10'), e('2', 30, 'earn', '11')]
    expect(balanceOf(ents)).toBe(100)
    expect(statement(ents).map((r) => [r.entry.id, r.balance])).toEqual([['1', 120], ['2', 150], ['3', 100]])
  })
  it('rules are checked', () => {
    expect(validateRules(rules)).toEqual([])
    expect(validateRules({ ...rules, earnPer: 0, pointValue: 0, minRedeem: 0, maxShareBp: 5 })).toEqual(['earn_per', 'point_value', 'min_redeem', 'max_share'])
    expect(validateRules({ ...rules, maxShareBp: 10_001 })).toEqual(['max_share'])
  })
})
