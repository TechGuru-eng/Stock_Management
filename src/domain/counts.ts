import type { Xaf } from './money'

/**
 * Stock counts (stock-takes). Rules, kept free of screens and databases so they can be tested on their own.
 *
 * How a count works:
 *  - Someone counts a product and records the number. At that moment the app also records what the system EXPECTED and the
 *    average cost, so the difference is measured against the right moment even if sales happen while counting continues.
 *  - A count can be "blind": the counter does not see the expected number (people count more honestly that way).
 *  - Recounting a product records a NEW line; the latest line wins. Nothing is edited or deleted.
 *  - A manager reviews the differences and approves or rejects. Approving posts one adjustment per product whose count
 *    differs, for the DIFFERENCE only (so sales made after the count are not undone).
 */

export interface CountRecord {
  id: string
  tenantId: string
  shopId: string
  name: string
  /** Counters do not see the expected quantities. */
  blind: boolean
  startedBy: string
  startedAt: string
}

export interface CountLineRecord {
  id: string
  tenantId: string
  countId: string
  productId: string
  /** Whole base units. */
  counted: number
  /** What the system said was in stock when this was counted. */
  expected: number
  /** Average cost of one base unit when this was counted. */
  unitCost: Xaf
  countedBy: string
  countedAt: string
}

export interface CountDecisionRecord {
  id: string
  tenantId: string
  countId: string
  decision: 'approved' | 'rejected'
  note?: string
  decidedBy: string
  decidedAt: string
}

export type CountStatus = 'open' | 'approved' | 'rejected'

export const countStatus = (decision: CountDecisionRecord | undefined): CountStatus => (decision ? decision.decision : 'open')

/** The newest line for each product (a recount replaces the earlier figure without deleting it). */
export function latestLines(lines: readonly CountLineRecord[]): CountLineRecord[] {
  const best = new Map<string, CountLineRecord>()
  for (const l of lines) {
    const cur = best.get(l.productId)
    if (!cur || l.countedAt > cur.countedAt || (l.countedAt === cur.countedAt && l.id > cur.id)) best.set(l.productId, l)
  }
  return [...best.values()]
}

export interface VarianceRow {
  productId: string
  name: string
  expected: number
  counted: number
  /** counted - expected: negative = missing stock, positive = surplus. */
  diff: number
  unitCost: Xaf
  /** diff x unit cost, rounded: what the difference is worth. */
  value: Xaf
  /** Large enough that a recount is advised before approving. */
  flagged: boolean
}

/** A difference of 10% of the expected quantity or more, or worth 10 000 FCFA or more, deserves a second look. */
export const FLAG_PERCENT_BP = 1000
export const FLAG_VALUE_XAF = 10_000

export function isFlagged(expected: number, diff: number, value: Xaf): boolean {
  if (diff === 0) return false
  const base = Math.max(Math.abs(expected), 1)
  return (Math.abs(diff) * 10000) / base >= FLAG_PERCENT_BP || Math.abs(value) >= FLAG_VALUE_XAF
}

export function varianceRows(lines: readonly CountLineRecord[], names: ReadonlyMap<string, string>): VarianceRow[] {
  return latestLines(lines)
    .map((l) => {
      const diff = l.counted - l.expected
      const value = Math.round(diff * l.unitCost)
      return {
        productId: l.productId, name: names.get(l.productId) ?? '—', expected: l.expected, counted: l.counted, diff, unitCost: l.unitCost, value,
        flagged: isFlagged(l.expected, diff, value),
      }
    })
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.name.localeCompare(b.name))
}

export interface CountSummary {
  counted: number
  withDifference: number
  matching: number
  flagged: number
  surplusValue: Xaf
  shortageValue: Xaf
  netValue: Xaf
  /** Share of counted products that matched exactly, in basis points (null when nothing is counted). */
  accuracyBp: number | null
}

export function summarizeCount(rows: readonly VarianceRow[]): CountSummary {
  const withDifference = rows.filter((r) => r.diff !== 0)
  const surplusValue = withDifference.filter((r) => r.value > 0).reduce((t, r) => t + r.value, 0)
  const shortageValue = withDifference.filter((r) => r.value < 0).reduce((t, r) => t - r.value, 0)
  return {
    counted: rows.length, withDifference: withDifference.length, matching: rows.length - withDifference.length,
    flagged: rows.filter((r) => r.flagged).length, surplusValue, shortageValue, netValue: surplusValue - shortageValue,
    accuracyBp: rows.length ? Math.round(((rows.length - withDifference.length) * 10000) / rows.length) : null,
  }
}

/** What approving posts: one adjustment per product whose count differs, for the difference only. */
export function adjustmentsFor(rows: readonly VarianceRow[]): { productId: string; qty: number }[] {
  return rows.filter((r) => r.diff !== 0).map((r) => ({ productId: r.productId, qty: r.diff }))
}

/** Counted quantities are whole, never negative. */
export function validCountedQty(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000_000
}
