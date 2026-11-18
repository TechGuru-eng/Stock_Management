import { db } from './db'
import type { Ctx } from './repo'
import {
  DEFAULT_ALERTS, active, computeAlerts, newAlerts, snoozeUntil,
  type AlertSettings, type Known, type StockAlert,
} from '../domain/alerts'
import { onOrder, salesSpeed } from '../domain/reorder'

const SETTINGS = 'alertSettings'
const SNOOZE = 'alertSnooze'
const knownKey = (shopId: string) => `alertKnown:${shopId}`
/** Selling speed is averaged over this many past days. */
export const ALERT_WINDOW_DAYS = 30

export async function loadAlertSettings(): Promise<AlertSettings> {
  return { ...DEFAULT_ALERTS, ...(((await db.meta.get(SETTINGS))?.value as Partial<AlertSettings> | undefined) ?? {}) }
}
export async function saveAlertSettings(s: Partial<AlertSettings>): Promise<void> {
  const cur = await loadAlertSettings()
  const leadDays = s.leadDays === undefined ? cur.leadDays : Math.min(Math.max(Math.floor(s.leadDays), 1), 60)
  await db.meta.put({ key: SETTINGS, value: { ...cur, ...s, leadDays } })
}

export async function loadSnoozed(): Promise<Record<string, string>> {
  return ((await db.meta.get(SNOOZE))?.value as Record<string, string> | undefined) ?? {}
}
export async function snoozeProduct(productId: string, days: number, now = new Date()): Promise<void> {
  const cur = await loadSnoozed()
  await db.meta.put({ key: SNOOZE, value: { ...cur, [productId]: snoozeUntil(now, days) } })
}
export async function unsnoozeProduct(productId: string): Promise<void> {
  const { [productId]: _gone, ...rest } = await loadSnoozed()
  void _gone
  await db.meta.put({ key: SNOOZE, value: rest })
}

/** Every product of the current shop that needs attention, worst first, computed fresh from the records. */
export async function loadStockAlerts(ctx: Ctx, settings: AlertSettings, now = new Date()): Promise<StockAlert[]> {
  const from = new Date(now.getTime() - ALERT_WINDOW_DAYS * 86_400_000).toISOString()
  const [products, costs, sales, lines, returns, returnLines, purchases, purchaseLines, receiptLines] = await Promise.all([
    db.products.toArray(), db.costs.where('shopId').equals(ctx.shopId).toArray(), db.sales.toArray(), db.saleLines.toArray(), db.saleReturns.toArray(),
    db.returnLines.toArray(), db.purchases.toArray(), db.purchaseLines.toArray(), db.receiptLines.toArray(),
  ])
  const speed = salesSpeed({ sales, lines, returns, returnLines, shopId: ctx.shopId, from, to: now.toISOString(), windowDays: ALERT_WINDOW_DAYS })
  return computeAlerts(
    products.map((p) => ({ id: p.id, name: p.name, minStock: p.minStock, isService: p.isService, active: p.active, baseUnit: p.baseUnit })),
    new Map(costs.map((c) => [c.productId, c.quantity])), speed, onOrder(ctx.shopId, purchases, purchaseLines, receiptLines), settings,
  )
}

/** The alerts to act on now: not covered by an order, not snoozed. */
export async function loadActiveAlerts(ctx: Ctx, now = new Date()): Promise<{ all: StockAlert[]; active: StockAlert[]; settings: AlertSettings }> {
  const settings = await loadAlertSettings()
  const all = await loadStockAlerts(ctx, settings, now)
  return { all, active: active(all, await loadSnoozed(), now), settings }
}

/**
 * Which of the current alerts are new (or worse) since this device last told the person, and remember them. Call it once per
 * change of the alert list; the same alert is never returned twice.
 */
export async function takeNewAlerts(ctx: Ctx, current: readonly StockAlert[]): Promise<StockAlert[]> {
  const key = knownKey(ctx.shopId)
  const known = ((await db.meta.get(key))?.value as Known | undefined) ?? {}
  const { notify, next } = newAlerts(current, known)
  if (JSON.stringify(next) !== JSON.stringify(known)) await db.meta.put({ key, value: next })
  return notify
}
