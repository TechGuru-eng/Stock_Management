import { db, deviceId, newId, type MovementRec } from './db'
import { can } from '../domain/permissions'
import { issue, receive } from '../domain/costing'
import {
  adjustmentsFor, countStatus, validCountedQty, varianceRows,
  type CountDecisionRecord, type CountLineRecord, type CountRecord,
} from '../domain/counts'
import { loadCost, queue, saveCost, type Ctx } from './repo'

/** Average cost of one base unit right now (falls back to the last known cost when nothing is in stock). */
function avgCost(s: { quantity: number; value: number; lastUnitCost: number }): number {
  return s.quantity > 0 ? Math.round(s.value / s.quantity) : s.lastUnitCost
}

async function openCount(countId: string): Promise<CountRecord> {
  const c = await db.stockCounts.get(countId)
  if (!c) throw new Error('count not found')
  if (await db.countDecisions.where('countId').equals(countId).first()) throw new Error('this count has already been decided')
  return c
}

export async function startCount(ctx: Ctx, input: { name: string; blind: boolean }): Promise<CountRecord> {
  if (!can(ctx.role, 'stock.count')) throw new Error('not allowed to count stock')
  const name = input.name.trim()
  if (name.length < 1 || name.length > 80) throw new Error('give the count a name (80 characters at most)')
  const c: CountRecord = { id: newId(), tenantId: ctx.tenantId, shopId: ctx.shopId, name, blind: input.blind, startedBy: ctx.userId, startedAt: new Date().toISOString() }
  await db.transaction('rw', [db.stockCounts, db.outbox], async () => {
    await db.stockCounts.add(c)
    await queue('stock_counts', c, c.id)
  })
  return c
}

/**
 * Record what was counted for one product. It also records what the system expected and the average cost at THIS moment, so
 * sales made while counting carries on do not distort the difference. Counting again adds a newer line; nothing is edited.
 */
export async function recordCount(ctx: Ctx, countId: string, productId: string, counted: number): Promise<CountLineRecord> {
  if (!can(ctx.role, 'stock.count')) throw new Error('not allowed to count stock')
  if (!validCountedQty(counted)) throw new Error('the counted quantity must be a whole number, zero or more')
  return db.transaction('rw', [db.stockCounts, db.countLines, db.countDecisions, db.costs, db.outbox], async () => {
    const c = await openCount(countId)
    if (c.shopId !== ctx.shopId) throw new Error('this count belongs to another shop')
    const state = await loadCost(ctx.shopId, productId)
    const line: CountLineRecord = {
      id: newId(), tenantId: ctx.tenantId, countId, productId, counted, expected: state.quantity, unitCost: avgCost(state),
      countedBy: ctx.userId, countedAt: new Date().toISOString(),
    }
    await db.countLines.add(line)
    await queue('stock_count_lines', line, line.id)
    return line
  })
}

/**
 * Approve a count: post one adjustment per product whose count differs, for the DIFFERENCE only, together with the decision, as
 * one all-or-nothing upload. Gains come in at the current average cost; losses leave at it.
 */
export async function approveCount(ctx: Ctx, countId: string): Promise<{ adjusted: number }> {
  if (!can(ctx.role, 'stock.adjust_approve')) throw new Error('not allowed to approve a count')
  return db.transaction('rw', [db.stockCounts, db.countLines, db.countDecisions, db.movements, db.costs, db.products, db.outbox], async () => {
    const c = await openCount(countId)
    if (c.shopId !== ctx.shopId) throw new Error('this count belongs to another shop')
    const lines = await db.countLines.where('countId').equals(countId).toArray()
    const names = new Map((await db.products.toArray()).map((p) => [p.id, p.name]))
    const adjustments = adjustmentsFor(varianceRows(lines, names))
    const decisionId = newId()
    const at = new Date().toISOString()

    for (const a of adjustments) {
      const state = await loadCost(ctx.shopId, a.productId)
      const cost = avgCost(state)
      let next, total
      if (a.qty > 0) {
        total = a.qty * cost
        next = receive(state, a.qty, total)
      } else {
        const out = issue(state, -a.qty)
        total = out.cogs
        next = out.state
      }
      await saveCost(ctx.shopId, a.productId, next)
      const m: MovementRec = {
        id: newId(), tenantId: ctx.tenantId, shopId: ctx.shopId, productId: a.productId, quantity: a.qty, type: 'count_adjustment',
        reason: `stock count: ${c.name}`, staffId: ctx.userId, deviceId: deviceId(), createdAt: at, referenceId: countId,
        unitCost: Math.round(total / Math.abs(a.qty)), totalCost: total,
      }
      await db.movements.add(m)
      await queue('stock_movements', m, decisionId)
    }
    const d: CountDecisionRecord = { id: decisionId, tenantId: ctx.tenantId, countId, decision: 'approved', decidedBy: ctx.userId, decidedAt: at }
    await db.countDecisions.add(d)
    await queue('stock_count_decisions', d, decisionId)
    return { adjusted: adjustments.length }
  })
}

export async function rejectCount(ctx: Ctx, countId: string, note: string): Promise<void> {
  if (!can(ctx.role, 'stock.adjust_approve')) throw new Error('not allowed to reject a count')
  if (!note.trim()) throw new Error('say why the count is rejected')
  await db.transaction('rw', [db.stockCounts, db.countLines, db.countDecisions, db.outbox], async () => {
    await openCount(countId)
    const d: CountDecisionRecord = { id: newId(), tenantId: ctx.tenantId, countId, decision: 'rejected', note: note.trim(), decidedBy: ctx.userId, decidedAt: new Date().toISOString() }
    await db.countDecisions.add(d)
    await queue('stock_count_decisions', d, d.id)
  })
}

export { countStatus }
