/**
 * Low-stock alerts. Which products need attention NOW, how bad it is, whether an order already covers it, whether it was snoozed,
 * and which alerts are NEW since the person was last told (so a notification is sent once, not on every sale). Pure rules.
 */
export type AlertLevel = 'running_out' | 'low' | 'out'
export const LEVEL_RANK: Record<AlertLevel, number> = { running_out: 1, low: 2, out: 3 }

export interface AlertSettings {
  /** A product that will run out in fewer days than this (at its recent selling speed) is flagged. */
  leadDays: number
  /** Show a system notification on this device when something gets worse. */
  notify: boolean
}
export const DEFAULT_ALERTS: AlertSettings = { leadDays: 7, notify: false }

export interface AlertProduct {
  id: string
  name: string
  minStock: number
  isService: boolean
  active: boolean
  baseUnit: string
}

export interface StockAlert {
  productId: string
  name: string
  baseUnit: string
  level: AlertLevel
  onHand: number
  onOrder: number
  minStock: number
  /** Days the stock lasts at the recent selling speed (null when it is not selling). */
  daysLeft: number | null
  /** An order already placed brings enough: shown, but not counted and not notified. */
  covered: boolean
}

export function computeAlerts(
  products: readonly AlertProduct[],
  onHand: ReadonlyMap<string, number>,
  speed: ReadonlyMap<string, number>,
  incoming: ReadonlyMap<string, number>,
  s: AlertSettings,
): StockAlert[] {
  const out: StockAlert[] = []
  for (const p of products) {
    if (p.isService || !p.active) continue
    const have = onHand.get(p.id) ?? 0
    const rate = speed.get(p.id) ?? 0
    const coming = incoming.get(p.id) ?? 0
    const daysLeft = rate > 0 ? Math.max(have, 0) / rate : null
    let level: AlertLevel | null = null
    // a product nobody buys and that has no minimum is never an alert, however empty its shelf
    if (have <= 0 && (rate > 0 || p.minStock > 0)) level = 'out'
    else if (p.minStock > 0 && have <= p.minStock) level = 'low'
    else if (daysLeft !== null && daysLeft < s.leadDays) level = 'running_out'
    if (!level) continue
    const covered = coming > 0 && have + coming > Math.max(p.minStock, Math.ceil(rate * s.leadDays))
    out.push({ productId: p.id, name: p.name, baseUnit: p.baseUnit, level, onHand: have, onOrder: coming, minStock: p.minStock, daysLeft, covered })
  }
  return out.sort((a, b) => Number(a.covered) - Number(b.covered) || LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9) || a.name.localeCompare(b.name))
}

/** Snoozed products are hidden until their time is up. `until` maps product id to an ISO time. */
export function isSnoozed(until: Readonly<Record<string, string>>, productId: string, now: Date): boolean {
  const t = until[productId]
  return Boolean(t) && new Date(t).getTime() > now.getTime()
}

export const snoozeUntil = (now: Date, days: number): string => new Date(now.getTime() + days * 86_400_000).toISOString()

/** The alerts a person should act on: not covered by an order, not snoozed. */
export function active(alerts: readonly StockAlert[], snoozed: Readonly<Record<string, string>>, now: Date): StockAlert[] {
  return alerts.filter((a) => !a.covered && !isSnoozed(snoozed, a.productId, now))
}

export type Known = Record<string, AlertLevel>

/**
 * Compares today's alerts with what the person was last told. Returns the alerts that are NEW or got WORSE (so they should be
 * notified now) and the new "last told" record (products that are fine again are forgotten, so a later return of the problem is new).
 */
export function newAlerts(current: readonly StockAlert[], known: Readonly<Known>): { notify: StockAlert[]; next: Known } {
  const next: Known = {}
  const notify: StockAlert[] = []
  for (const a of current) {
    const before = known[a.productId]
    next[a.productId] = before && LEVEL_RANK[before] >= LEVEL_RANK[a.level] ? before : a.level
    if (!before || LEVEL_RANK[a.level] > LEVEL_RANK[before]) notify.push(a)
  }
  return { notify, next }
}

export const countByLevel = (alerts: readonly StockAlert[]): Record<AlertLevel, number> => ({
  out: alerts.filter((a) => a.level === 'out').length,
  low: alerts.filter((a) => a.level === 'low').length,
  running_out: alerts.filter((a) => a.level === 'running_out').length,
})

/** A short text for a notification or a message. */
export function digestText(lang: 'fr' | 'en', shopName: string, alerts: readonly StockAlert[], max = 12): string {
  const L = {
    fr: { head: `Stock à surveiller — ${shopName}`, out: 'rupture', low: 'stock bas', running_out: 'bientôt fini', more: (n: number) => `… et ${n} autre(s)`, none: 'Rien à signaler.' },
    en: { head: `Stock to watch — ${shopName}`, out: 'out of stock', low: 'low stock', running_out: 'running out', more: (n: number) => `… and ${n} more`, none: 'Nothing to report.' },
  }[lang]
  if (alerts.length === 0) return `${L.head}\n${L.none}`
  const lines = alerts.slice(0, max).map((a) => `- ${a.name}: ${Math.max(a.onHand, 0)} ${a.baseUnit} (${L[a.level]})`)
  if (alerts.length > max) lines.push(L.more(alerts.length - max))
  return [L.head, ...lines].join('\n')
}
