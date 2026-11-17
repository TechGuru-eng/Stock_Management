import { db, deviceId, newId, type MovementRec } from './db'
import { loadCost, nextRef, queue, saveCost, type Ctx } from './repo'
import { receive } from '../domain/costing'
import { PaymentError } from '../domain/payments'
import { can } from '../domain/permissions'
import {
  buildApprovalRequest, buildDecision, buildReturn, fullReturn, pendingRequests,
  type ApprovalRequestRecord, type ReturnRequest,
} from '../domain/returns'

function actor(ctx: Ctx) {
  return { newId, tenantId: ctx.tenantId, shopId: ctx.shopId, userId: ctx.userId, deviceId: deviceId(), nowIso: new Date().toISOString() }
}

const TABLES = [
  db.sales, db.saleLines, db.saleReturns, db.returnLines, db.movements, db.costs, db.transactions, db.customerEntries,
  db.allocations, db.approvalRequests, db.approvalDecisions, db.meta, db.outbox,
]

/** Everything the rules need to know about one sale, read from the ledger. */
export async function saleFacts(saleId: string) {
  const sale = await db.sales.get(saleId)
  if (!sale) throw new PaymentError('sale not found')
  const saleLines = await db.saleLines.where('saleId').equals(saleId).toArray()
  const returns = await db.saleReturns.where('saleId').equals(saleId).toArray()
  const priorLines = returns.length ? await db.returnLines.where('returnId').anyOf(returns.map((r) => r.id)).toArray() : []
  const allocated = (await db.allocations.where('saleId').equals(saleId).toArray()).reduce((t, a) => t + a.amount, 0)
  const collected = (await db.transactions.where('saleId').equals(saleId).toArray())
    .filter((t) => t.txnType === 'sale_collection').reduce((t, x) => t + x.amount, 0)
  const refunded = returns.reduce((t, r) => t + r.refundedAmount, 0)
  const debtReduced = returns.reduce((t, r) => t + r.debtReduced, 0)
  return {
    sale, saleLines, returns, priorLines,
    openOnSale: sale.outstanding - allocated - debtReduced,
    // money the customer really paid for this sale (at the till or by later repayment) minus refunds already paid
    refundableMoney: collected + allocated - refunded,
  }
}

async function execute(ctx: Ctx, saleId: string, request: ReturnRequest, decisionFor?: string) {
  const f = await saleFacts(saleId)
  const r = buildReturn({
    ...actor(ctx), sale: f.sale, saleLines: f.saleLines, priorLines: f.priorLines, request,
    openOnSale: f.openOnSale, refundableMoney: f.refundableMoney, approvedBy: ctx.userId,
    reference: await nextRef(ctx.shopId, 'rf'),
  })

  for (const m of r.movements) {
    await saveCost(ctx.shopId, m.productId, receive(await loadCost(ctx.shopId, m.productId), m.quantity, m.totalCost ?? 0))
  }
  await db.saleReturns.add(r.ret)
  await db.returnLines.bulkAdd(r.lines)
  await db.movements.bulkAdd(r.movements.map((m): MovementRec => ({ ...m, tenantId: ctx.tenantId })))
  if (r.transaction) await db.transactions.add(r.transaction)
  if (r.entry) await db.customerEntries.add(r.entry)

  // One group, in dependency order: the return first, then everything that points at it.
  const g = r.ret.id
  await queue('sale_returns', r.ret, g)
  for (const l of r.lines) await queue('sale_return_lines', l, g)
  for (const m of r.movements) await queue('stock_movements', { ...m, tenantId: ctx.tenantId }, g)
  if (r.transaction) await queue('financial_transactions', r.transaction, g)
  if (r.entry) await queue('customer_account_entries', r.entry, g)
  if (decisionFor) {
    const d = buildDecision({ ...actor(ctx), requestId: decisionFor, decision: 'approved', returnId: r.ret.id })
    await db.approvalDecisions.add(d)
    await queue('approval_decisions', d, g)
  }
  return r
}

/** Direct return: only a manager or owner can do this. */
export async function processReturn(ctx: Ctx, saleId: string, request: ReturnRequest) {
  if (!can(ctx.role, 'sales.refund_approve')) throw new PaymentError('only a manager or the owner can process a return; ask for approval instead')
  return db.transaction('rw', TABLES, () => execute(ctx, saleId, request))
}

/** Cancel a whole sale: everything goes back and everything paid or owed is reversed. */
export async function cancelSale(ctx: Ctx, saleId: string, reason: string, refundMethod?: 'cash' | 'mtn_momo' | 'orange_money') {
  if (!can(ctx.role, 'sales.refund_approve')) throw new PaymentError('only a manager or the owner can cancel a sale; ask for approval instead')
  return db.transaction('rw', TABLES, async () => {
    const f = await saleFacts(saleId)
    return execute(ctx, saleId, { kind: 'cancellation', reason, refundMethod, lines: fullReturn(f.saleLines, f.priorLines) })
  })
}

/** A cashier asks; nothing changes until a manager or owner approves. */
export async function requestReturn(ctx: Ctx, saleId: string, request: ReturnRequest): Promise<ApprovalRequestRecord> {
  if (!can(ctx.role, 'sales.request_refund') && !can(ctx.role, 'sales.refund_approve')) throw new PaymentError('you do not have permission for this action')
  return db.transaction('rw', TABLES, async () => {
    const f = await saleFacts(saleId)
    // Check it could work, so the manager is not sent a request that can never be approved.
    buildReturn({
      ...actor(ctx), sale: f.sale, saleLines: f.saleLines, priorLines: f.priorLines, request, openOnSale: f.openOnSale,
      refundableMoney: f.refundableMoney, reference: 'check',
    })
    const r = buildApprovalRequest({ ...actor(ctx), saleId, request })
    await db.approvalRequests.add(r)
    await queue('approval_requests', r, r.id)
    return r
  })
}

export async function pendingApprovals(): Promise<ApprovalRequestRecord[]> {
  return pendingRequests(await db.approvalRequests.toArray(), await db.approvalDecisions.toArray())
}

export async function approveRequest(ctx: Ctx, requestId: string) {
  if (!can(ctx.role, 'sales.refund_approve')) throw new PaymentError('only a manager or the owner can approve')
  return db.transaction('rw', TABLES, async () => {
    const req = await db.approvalRequests.get(requestId)
    if (!req) throw new PaymentError('request not found')
    if (!(await pendingApprovals()).some((p) => p.id === requestId)) throw new PaymentError('this request was already decided')
    return execute(ctx, req.payload.saleId, req.payload.request, requestId)
  })
}

export async function rejectRequest(ctx: Ctx, requestId: string, note: string) {
  if (!can(ctx.role, 'sales.refund_approve')) throw new PaymentError('only a manager or the owner can reject')
  return db.transaction('rw', TABLES, async () => {
    if (!(await pendingApprovals()).some((p) => p.id === requestId)) throw new PaymentError('this request was already decided')
    const d = buildDecision({ ...actor(ctx), requestId, decision: 'rejected', note })
    await db.approvalDecisions.add(d)
    await queue('approval_decisions', d, d.id)
    return d
  })
}
