import { describe, expect, it } from 'vitest'
import {
  addMonths, canAdd, canWrite, DEFAULT_TERMS, limitsExceeded, newPeriodEnd, quote, reminderLevel, subscriptionState, upgradeCharge,
  type PlanDef,
} from './subscription'

const DAY = 86_400_000
const t0 = Date.parse('2026-11-17T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

const starter: PlanDef = { code: 'starter', name: 'Starter', priceXaf: 2500, maxShops: 1, maxStaff: 2, maxProducts: 500 }
const business: PlanDef = { code: 'business', name: 'Business', priceXaf: 5000, maxShops: 1, maxStaff: 5, maxProducts: 5000 }
const pro: PlanDef = { code: 'pro', name: 'Pro', priceXaf: 10000, maxShops: 3, maxStaff: 15, maxProducts: null }
const enterprise: PlanDef = { code: 'enterprise', name: 'Enterprise', priceXaf: null, maxShops: null, maxStaff: null, maxProducts: null }

describe('subscription state (test 15)', () => {
  const end = t0 + 10 * DAY
  it('trial and active run in full until the period ends', () => {
    expect(subscriptionState({ kind: 'trial', periodEnd: iso(end) }, t0).status).toBe('trial')
    expect(subscriptionState({ kind: 'active', periodEnd: iso(end) }, t0).status).toBe('active')
    expect(subscriptionState({ kind: 'active', periodEnd: iso(end) }, t0).daysLeft).toBe(10)
  })
  it('a 7-day grace period follows, with full use and a countdown', () => {
    const s = subscriptionState({ kind: 'active', periodEnd: iso(end) }, end + 2 * DAY)
    expect(s.status).toBe('grace')
    expect(s.graceDaysLeft).toBe(5)
    expect(canWrite(s.status)).toBe(true)
  })
  it('after grace it is expired and read-only; data is never deleted', () => {
    const s = subscriptionState({ kind: 'active', periodEnd: iso(end) }, end + 8 * DAY)
    expect(s.status).toBe('expired')
    expect(canWrite(s.status)).toBe(false)
  })
  it('the grace length is a setting, not a constant', () => {
    expect(subscriptionState({ kind: 'active', periodEnd: iso(end) }, end + 8 * DAY, 14).status).toBe('grace')
  })
  it('a suspended account is read-only whatever its dates say', () => {
    const s = subscriptionState({ kind: 'active', periodEnd: iso(end), suspended: true }, t0)
    expect(s.status).toBe('suspended')
    expect(canWrite(s.status)).toBe(false)
  })
  it('the boundary moments', () => {
    expect(subscriptionState({ kind: 'active', periodEnd: iso(end) }, end - 1).status).toBe('active')
    expect(subscriptionState({ kind: 'active', periodEnd: iso(end) }, end).status).toBe('grace')
    expect(subscriptionState({ kind: 'active', periodEnd: iso(end) }, end + 7 * DAY - 1).status).toBe('grace')
    expect(subscriptionState({ kind: 'active', periodEnd: iso(end) }, end + 7 * DAY).status).toBe('expired')
  })
})

describe('renewal reminders', () => {
  const at = (daysBeforeEnd: number) => subscriptionState({ kind: 'active', periodEnd: iso(t0 + daysBeforeEnd * DAY) }, t0)
  it('quiet, then 5 days, then 2 days, then grace, then expired', () => {
    expect(reminderLevel(at(20))).toBe('none')
    expect(reminderLevel(at(5))).toBe('soon')
    expect(reminderLevel(at(2))).toBe('urgent')
    expect(reminderLevel(at(-1))).toBe('grace')
    expect(reminderLevel(at(-8))).toBe('expired')
  })
})

describe('plans, terms and prices (FCFA)', () => {
  it('quotes a month, a quarter, and paying ahead for free months', () => {
    expect(quote(business, DEFAULT_TERMS[0])).toEqual({ amount: 5000, periodMonths: 1 })
    expect(quote(business, DEFAULT_TERMS[1])).toEqual({ amount: 15000, periodMonths: 3 })
    expect(quote(business, DEFAULT_TERMS[2])).toEqual({ amount: 30000, periodMonths: 7 }) // pay 6, get 7
    expect(quote(starter, DEFAULT_TERMS[3])).toEqual({ amount: 30000, periodMonths: 14 }) // pay 12, get 14
  })
  it('Enterprise is not self-serve', () => {
    expect(() => quote(enterprise, DEFAULT_TERMS[0])).toThrow('custom pricing')
  })
  it('month arithmetic matches the database (end-of-month clamps)', () => {
    expect(iso(addMonths(Date.parse('2026-01-31T10:00:00Z'), 1))).toBe('2026-02-28T10:00:00.000Z')
    expect(iso(addMonths(Date.parse('2028-01-31T10:00:00Z'), 1))).toBe('2028-02-29T10:00:00.000Z')
    expect(iso(addMonths(Date.parse('2026-11-17T12:00:00Z'), 3))).toBe('2027-02-17T12:00:00.000Z')
    expect(iso(addMonths(Date.parse('2026-12-15T00:00:00Z'), 1))).toBe('2027-01-15T00:00:00.000Z')
  })
  it('renewing early extends from the end; renewing late starts from today', () => {
    const now = Date.parse('2026-11-17T12:00:00Z')
    expect(iso(newPeriodEnd(Date.parse('2026-12-01T12:00:00Z'), now, 1))).toBe('2027-01-01T12:00:00.000Z')
    expect(iso(newPeriodEnd(Date.parse('2026-10-01T12:00:00Z'), now, 1))).toBe('2026-12-17T12:00:00.000Z')
  })
})

describe('changing plan', () => {
  it('an upgrade pays the difference for the days left, rounded up', () => {
    expect(upgradeCharge(2500, 5000, 15)).toBe(1250)
    expect(upgradeCharge(2500, 5000, 20)).toBe(1667) // 1,666.67 rounded up
    expect(upgradeCharge(5000, 10000, 30)).toBe(5000)
  })
  it('a downgrade or a lapsed period costs nothing here', () => {
    expect(upgradeCharge(5000, 2500, 15)).toBe(0)
    expect(upgradeCharge(2500, 5000, 0)).toBe(0)
  })
  it('a downgrade is refused while usage breaks the lower plan', () => {
    expect(limitsExceeded(starter, { shops: 1, staff: 2, products: 400 })).toEqual([])
    expect(limitsExceeded(starter, { shops: 1, staff: 4, products: 900 })).toEqual(['staff', 'products'])
    expect(limitsExceeded(pro, { shops: 3, staff: 15, products: 99999 })).toEqual([]) // unlimited products
  })
  it('plan limits stop the one-too-many', () => {
    expect(canAdd(starter, 'products', { shops: 1, staff: 0, products: 499 })).toBe(true)
    expect(canAdd(starter, 'products', { shops: 1, staff: 0, products: 500 })).toBe(false)
    expect(canAdd(pro, 'products', { shops: 1, staff: 0, products: 100000 })).toBe(true)
    expect(canAdd(business, 'shops', { shops: 1, staff: 0, products: 0 })).toBe(false)
  })
})
