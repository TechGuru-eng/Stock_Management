import type { Xaf } from './money'

/**
 * Customer loyalty points. Pure rules.
 *  - Points are EARNED on what the customer actually pays at the till (not on credit, not on the part covered by points).
 *  - Points can be REDEEMED against a sale: each point is worth a fixed number of FCFA, up to a share of the sale, never below a minimum.
 *  - A return or a cancelled sale takes back the points it earned; a cancelled sale gives back the points that were spent.
 *  - Balances are the sum of an append-only ledger; nothing is edited.
 */
export interface LoyaltyRules {
  enabled: boolean
  /** FCFA paid for each point earned (1000 = one point per 1 000 FCFA). */
  earnPer: Xaf
  /** FCFA of discount each point is worth when redeemed. */
  pointValue: Xaf
  /** Fewest points that can be redeemed in one go. */
  minRedeem: number
  /** The most of a sale (excluding tax) that points may cover, in basis points (5000 = half). */
  maxShareBp: number
}

export const DEFAULT_LOYALTY: LoyaltyRules = { enabled: false, earnPer: 1000, pointValue: 10, minRedeem: 50, maxShareBp: 5000 }

export type RuleProblem = 'earn_per' | 'point_value' | 'min_redeem' | 'max_share'

export function validateRules(r: LoyaltyRules): RuleProblem[] {
  const out: RuleProblem[] = []
  if (!Number.isInteger(r.earnPer) || r.earnPer < 1 || r.earnPer > 1_000_000) out.push('earn_per')
  if (!Number.isInteger(r.pointValue) || r.pointValue < 1 || r.pointValue > 100_000) out.push('point_value')
  if (!Number.isInteger(r.minRedeem) || r.minRedeem < 1 || r.minRedeem > 1_000_000) out.push('min_redeem')
  if (!Number.isInteger(r.maxShareBp) || r.maxShareBp < 100 || r.maxShareBp > 10_000) out.push('max_share')
  return out
}

/** What the program gives back, as a share of spending, in basis points (for the owner to judge the rules). */
export const rewardRateBp = (r: LoyaltyRules): number => Math.round((r.pointValue * 10_000) / r.earnPer)

export interface LoyaltyEntry {
  id: string
  tenantId: string
  customerId: string
  /** + earned / given back, - spent / taken back. */
  points: number
  kind: 'earn' | 'redeem' | 'reversal' | 'adjust'
  saleId?: string
  returnId?: string
  note?: string
  createdBy: string
  occurredAt: string
}

export const balanceOf = (entries: readonly Pick<LoyaltyEntry, 'points'>[]): number => entries.reduce((t, e) => t + e.points, 0)

/** Points earned by a sale: one per `earnPer` FCFA actually paid (rounded down). */
export function pointsEarned(paidNow: Xaf, rules: LoyaltyRules): number {
  if (!rules.enabled || paidNow <= 0) return 0
  return Math.floor(paidNow / rules.earnPer)
}

export const redeemValue = (points: number, rules: LoyaltyRules): Xaf => points * rules.pointValue

/**
 * The most points a customer can spend on this sale: no more than they have, no more than the allowed share of the sale
 * (`netBeforePoints` = the sale excluding tax after ordinary discounts), and zero if that is below the minimum.
 */
export function maxRedeemPoints(balance: number, netBeforePoints: Xaf, rules: LoyaltyRules): number {
  if (!rules.enabled || balance <= 0 || netBeforePoints <= 0) return 0
  const byShare = Math.floor(((netBeforePoints * rules.maxShareBp) / 10_000) / rules.pointValue)
  const p = Math.min(balance, byShare)
  return p >= rules.minRedeem ? p : 0
}

export type RedeemProblem = 'disabled' | 'not_enough_points' | 'below_minimum' | 'too_much_of_sale' | 'not_whole'

export function checkRedeem(points: number, balance: number, netBeforePoints: Xaf, rules: LoyaltyRules): RedeemProblem | null {
  if (!rules.enabled) return 'disabled'
  if (!Number.isInteger(points) || points <= 0) return 'not_whole'
  if (points > balance) return 'not_enough_points'
  if (points < rules.minRedeem) return 'below_minimum'
  if (redeemValue(points, rules) > Math.floor((netBeforePoints * rules.maxShareBp) / 10_000)) return 'too_much_of_sale'
  return null
}

/**
 * Spreads a discount over the lines in proportion to what each line is worth, with the rounding carried forward so the parts add up to
 * the exact total and no line is discounted by more than it costs.
 */
export function splitDiscount(total: Xaf, lineNets: readonly Xaf[]): Xaf[] {
  const sum = lineNets.reduce((t, n) => t + n, 0)
  if (total <= 0 || sum <= 0) return lineNets.map(() => 0)
  const t = Math.min(total, sum)
  let acc = 0
  let given = 0
  return lineNets.map((n, i) => {
    acc += n
    const upTo = i === lineNets.length - 1 ? t : Math.round((t * acc) / sum)
    const part = Math.min(upTo - given, n)
    given += part
    return part
  })
}

/**
 * Points to take back when goods come back. `earned` is what the sale earned and `alreadyReversed` what earlier returns already took back;
 * a part return takes back its share, a cancellation takes back everything that is left.
 */
export function reversalPoints(input: { earned: number; alreadyReversed: number; returnedValue: Xaf; saleTotal: Xaf; cancellation: boolean }): number {
  const left = Math.max(input.earned - input.alreadyReversed, 0)
  if (input.cancellation) return left
  if (input.saleTotal <= 0) return 0
  return Math.min(Math.floor((input.earned * input.returnedValue) / input.saleTotal), left)
}

export interface StatementRow { entry: LoyaltyEntry; balance: number }

/** The ledger with the running balance, oldest first. */
export function statement(entries: readonly LoyaltyEntry[]): StatementRow[] {
  let b = 0
  return [...entries].sort((a, c) => (a.occurredAt === c.occurredAt ? (a.id < c.id ? -1 : 1) : a.occurredAt < c.occurredAt ? -1 : 1)).map((entry) => ({ entry, balance: (b += entry.points) }))
}
