/**
 * Subscription rules. The same rules run in the database (migration 0011), which is the authority:
 * the app uses these to show the right message and to stop new records on a device that is out of date.
 *
 *   trial / active  full use
 *   grace           the paid period ended less than `graceDays` ago: full use, with a warning banner
 *   expired         read-only: view and export everything, record nothing new
 *   suspended       read-only, set by StockCM staff
 * Business records are NEVER deleted because a subscription lapsed.
 */

export interface PlanDef {
  code: string
  name: string
  /** null = custom pricing (Enterprise), not self-serve. */
  priceXaf: number | null
  /** null = unlimited. */
  maxShops: number | null
  maxStaff: number | null
  maxProducts: number | null
}

export type SubStatus = 'trial' | 'active' | 'grace' | 'expired' | 'suspended'

export interface SubscriptionRow {
  kind: 'trial' | 'active'
  periodEnd: string
  suspended?: boolean
}

export interface SubscriptionState {
  status: SubStatus
  periodEndMs: number
  graceEndMs: number
  /** Whole days until the paid period ends (negative once it has ended). */
  daysLeft: number
  /** Whole days left of the grace period (0 when not in grace). */
  graceDaysLeft: number
}

export const DEFAULT_GRACE_DAYS = 7
const DAY = 86_400_000

export function subscriptionState(sub: SubscriptionRow, nowMs: number, graceDays = DEFAULT_GRACE_DAYS): SubscriptionState {
  const periodEndMs = Date.parse(sub.periodEnd)
  const graceEndMs = periodEndMs + graceDays * DAY
  const daysLeft = Math.ceil((periodEndMs - nowMs) / DAY)
  let status: SubStatus
  if (sub.suspended) status = 'suspended'
  else if (nowMs < periodEndMs) status = sub.kind === 'trial' ? 'trial' : 'active'
  else if (nowMs < graceEndMs) status = 'grace'
  else status = 'expired'
  return { status, periodEndMs, graceEndMs, daysLeft, graceDaysLeft: status === 'grace' ? Math.ceil((graceEndMs - nowMs) / DAY) : 0 }
}

/** New records may be created only in these states. */
export const canWrite = (s: SubStatus): boolean => s === 'trial' || s === 'active' || s === 'grace'

export type ReminderLevel = 'none' | 'soon' | 'urgent' | 'grace' | 'expired'

/** Renewal reminders at 5 days, 2 days, then every day in grace. */
export function reminderLevel(state: SubscriptionState): ReminderLevel {
  if (state.status === 'expired' || state.status === 'suspended') return 'expired'
  if (state.status === 'grace') return 'grace'
  if (state.daysLeft <= 2) return 'urgent'
  if (state.daysLeft <= 5) return 'soon'
  return 'none'
}

/* ---------------------------------- pricing ---------------------------------- */

export interface BillingTerm {
  /** Months paid for. */
  months: number
  /** Extra free months for paying ahead. */
  bonus: number
}

/** Initial proposal (editable in the database, not in code): pay 6 months get 1 free, pay 12 get 2 free. */
export const DEFAULT_TERMS: readonly BillingTerm[] = [
  { months: 1, bonus: 0 },
  { months: 3, bonus: 0 },
  { months: 6, bonus: 1 },
  { months: 12, bonus: 2 },
]

export function quote(plan: PlanDef, term: BillingTerm): { amount: number; periodMonths: number } {
  if (plan.priceXaf === null) throw new Error('this plan has custom pricing')
  return { amount: plan.priceXaf * term.months, periodMonths: term.months + term.bonus }
}

/** Calendar month arithmetic that matches PostgreSQL (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms)
  const day = d.getUTCDate()
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target.getTime()
}

/** Renewing early extends from the current end; renewing late starts from today (no free time from lateness). */
export function newPeriodEnd(currentEndMs: number, nowMs: number, periodMonths: number): number {
  return addMonths(Math.max(currentEndMs, nowMs), periodMonths)
}

/** Upgrading mid-period: pay the price difference for the days left, rounded up to a whole XAF. */
export function upgradeCharge(oldPrice: number, newPrice: number, daysLeft: number): number {
  if (newPrice <= oldPrice || daysLeft <= 0) return 0
  return Math.ceil(((newPrice - oldPrice) * daysLeft) / 30)
}

export interface Usage {
  shops: number
  staff: number
  products: number
}

/** Which limits of a plan the current usage would break (empty = fits). Used before a downgrade. */
export function limitsExceeded(plan: PlanDef, u: Usage): ('shops' | 'staff' | 'products')[] {
  const out: ('shops' | 'staff' | 'products')[] = []
  if (plan.maxShops !== null && u.shops > plan.maxShops) out.push('shops')
  if (plan.maxStaff !== null && u.staff > plan.maxStaff) out.push('staff')
  if (plan.maxProducts !== null && u.products > plan.maxProducts) out.push('products')
  return out
}

/** Can one more of this be added? */
export function canAdd(plan: PlanDef, kind: keyof Usage, u: Usage): boolean {
  const max = kind === 'shops' ? plan.maxShops : kind === 'staff' ? plan.maxStaff : plan.maxProducts
  return max === null || u[kind] < max
}
