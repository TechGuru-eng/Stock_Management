import { db, newId } from './db'
import { queue, type Ctx } from './repo'
import { can } from '../domain/permissions'
import { DEFAULT_LOYALTY, balanceOf, reversalPoints, validateRules, type LoyaltyEntry, type LoyaltyRules } from '../domain/loyalty'
import type { ReturnRecord } from '../domain/returns'
import type { SaleRecord } from '../domain/pos'

export interface LoyaltyRulesRecord extends LoyaltyRules {
  id: string
  tenantId: string
  setBy: string
  setAt: string
}

/** The program's rules: the newest version saved (or the defaults, switched off, when nobody has set any). */
export async function loadRules(): Promise<LoyaltyRules> {
  const all = await db.loyaltyRules.toArray()
  const latest = all.sort((a, b) => (a.setAt === b.setAt ? (a.id < b.id ? 1 : -1) : a.setAt < b.setAt ? 1 : -1))[0]
  return latest ? { enabled: latest.enabled, earnPer: latest.earnPer, pointValue: latest.pointValue, minRedeem: latest.minRedeem, maxShareBp: latest.maxShareBp } : DEFAULT_LOYALTY
}

/** Save new rules (a new version; earlier versions are kept). Only people with settings rights: the owner. */
export async function saveRules(ctx: Ctx, rules: LoyaltyRules): Promise<void> {
  if (!can(ctx.role, 'settings.write')) throw new Error('only the owner can change the loyalty rules')
  const problems = validateRules(rules)
  if (problems.length) throw new Error(`invalid rules: ${problems.join(', ')}`)
  const rec: LoyaltyRulesRecord = { ...rules, id: newId(), tenantId: ctx.tenantId, setBy: ctx.userId, setAt: new Date().toISOString() }
  await db.transaction('rw', [db.loyaltyRules, db.outbox], async () => {
    await db.loyaltyRules.add(rec)
    await queue('loyalty_rules', rec, rec.id)
  })
}

export async function pointsOf(customerId: string): Promise<number> {
  return balanceOf(await db.loyaltyEntries.where('customerId').equals(customerId).toArray())
}

/** A manager's manual correction or gift of points. Needs a reason. */
export async function adjustPoints(ctx: Ctx, customerId: string, points: number, note: string): Promise<void> {
  if (!can(ctx.role, 'sales.refund_approve')) throw new Error('only a manager or the owner can adjust points')
  if (!Number.isInteger(points) || points === 0) throw new Error('points must be a whole number, not zero')
  if (!note.trim()) throw new Error('give a reason')
  if (!(await db.customers.get(customerId))) throw new Error('customer not found')
  const e: LoyaltyEntry = { id: newId(), tenantId: ctx.tenantId, customerId, points, kind: 'adjust', note: note.trim(), createdBy: ctx.userId, occurredAt: new Date().toISOString() }
  await db.transaction('rw', [db.loyaltyEntries, db.outbox], async () => {
    await db.loyaltyEntries.add(e)
    await queue('loyalty_entries', e, e.id)
  })
}

/**
 * Take back what a return or cancellation undoes. Runs INSIDE the return's transaction and upload group. A part return takes back its share of
 * the points the sale earned; a cancellation takes back all that is left AND gives back the points the customer spent on that sale (once).
 * (A part return does not refund spent points.)
 */
export async function reverseLoyaltyInTx(ctx: Ctx, sale: SaleRecord, ret: ReturnRecord, groupId: string): Promise<void> {
  if (!sale.customerId) return
  const entries = (await db.loyaltyEntries.where('customerId').equals(sale.customerId).toArray()).filter((e) => e.saleId === sale.id)
  if (entries.length === 0) return
  const earned = entries.filter((e) => e.kind === 'earn').reduce((t, e) => t + e.points, 0)
  const alreadyReversed = -entries.filter((e) => e.kind === 'reversal' && e.points < 0).reduce((t, e) => t + e.points, 0)
  const spent = -entries.filter((e) => e.kind === 'redeem').reduce((t, e) => t + e.points, 0)
  const givenBack = entries.filter((e) => e.kind === 'reversal' && e.points > 0).reduce((t, e) => t + e.points, 0)
  const cancellation = ret.kind === 'cancellation'
  const out: LoyaltyEntry[] = []
  const take = reversalPoints({ earned, alreadyReversed, returnedValue: ret.totalValue, saleTotal: sale.total, cancellation })
  const base = { id: '', tenantId: ctx.tenantId, customerId: sale.customerId, saleId: sale.id, returnId: ret.id, createdBy: ctx.userId, occurredAt: ret.occurredAt }
  if (take > 0) out.push({ ...base, id: newId(), points: -take, kind: 'reversal', note: cancellation ? 'sale cancelled' : 'goods returned' })
  if (cancellation && spent - givenBack > 0) out.push({ ...base, id: newId(), points: spent - givenBack, kind: 'reversal', note: 'points spent on a cancelled sale' })
  for (const e of out) {
    await db.loyaltyEntries.add(e)
    await queue('loyalty_entries', e, groupId)
  }
}
