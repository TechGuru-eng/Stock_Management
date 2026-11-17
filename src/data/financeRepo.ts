import { db, deviceId, newId } from './db'
import { nextRef, queue, type Ctx } from './repo'
import {
  buildCashMovement, buildClosure, buildExpense, buildRepayment, openSalesOf,
  type CashClosureRecord, type CashSessionRecord, type ExpenseCategory,
} from '../domain/finance'
import { can } from '../domain/permissions'
import { PaymentError } from '../domain/payments'

function actor(ctx: Ctx) {
  return { newId, tenantId: ctx.tenantId, shopId: ctx.shopId, userId: ctx.userId, deviceId: deviceId(), nowIso: new Date().toISOString() }
}

function need(ctx: Ctx, permission: string) {
  if (!can(ctx.role, permission)) throw new PaymentError('you do not have permission for this action')
}

const MONEY_TABLES = [db.transactions, db.payments, db.allocations, db.customerEntries, db.expenses, db.cashSessions, db.cashClosures, db.sales, db.meta, db.outbox]

/* ------------------------------ debt repayment ------------------------------ */

/** What a customer still owes on each unpaid sale (oldest first). */
export async function openSalesForCustomer(customerId: string) {
  const sales = (await db.sales.where('customerId').equals(customerId).toArray()).filter((s) => s.outstanding > 0)
  const allocations = sales.length ? await db.allocations.where('saleId').anyOf(sales.map((s) => s.id)).toArray() : []
  return openSalesOf(sales, allocations)
}

export async function repayDebt(ctx: Ctx, args: { customerId: string; amount: number; method: 'cash' | 'mtn_momo' | 'orange_money' }) {
  need(ctx, 'payments.receive')
  return db.transaction('rw', MONEY_TABLES, async () => {
    const r = buildRepayment({
      ...actor(ctx), customerId: args.customerId, method: args.method, amount: args.amount,
      reference: await nextRef(ctx.shopId, 'rp'), openSales: await openSalesForCustomer(args.customerId),
    })
    await db.transactions.add(r.transaction)
    await db.payments.add(r.payment)
    await db.allocations.bulkAdd(r.allocations)
    await db.customerEntries.add(r.entry)
    // One group, in dependency order: the money entry first, then what refers to it.
    const g = r.payment.id
    await queue('financial_transactions', r.transaction, g)
    await queue('payments', r.payment, g)
    for (const a of r.allocations) await queue('payment_allocations', a, g)
    await queue('customer_account_entries', r.entry, g)
    return r
  })
}

/* --------------------------------- expenses --------------------------------- */

export async function recordExpense(
  ctx: Ctx,
  args: { category: ExpenseCategory; amount: number; method: 'cash' | 'mtn_momo' | 'orange_money'; description?: string },
) {
  need(ctx, 'expenses.write')
  return db.transaction('rw', MONEY_TABLES, async () => {
    const r = buildExpense({ ...actor(ctx), ...args, reference: await nextRef(ctx.shopId, 'ex') })
    await db.transactions.add(r.transaction)
    await db.expenses.add(r.expense)
    const g = r.expense.id
    await queue('financial_transactions', r.transaction, g)
    await queue('expenses', r.expense, g)
    return r
  })
}

/* ------------------------------ till movements ------------------------------ */

export async function moveCash(ctx: Ctx, args: { kind: 'cash_deposit' | 'cash_withdrawal'; amount: number; reason: string }) {
  need(ctx, 'finance.write')
  return db.transaction('rw', MONEY_TABLES, async () => {
    const t = buildCashMovement({ ...actor(ctx), ...args, reference: await nextRef(ctx.shopId, args.kind === 'cash_deposit' ? 'cd' : 'cw') })
    await db.transactions.add(t)
    await queue('financial_transactions', t, t.id)
    return t
  })
}

/* ------------------------------- cash sessions ------------------------------- */

/** The user's open session in this shop, if any (a session is open until a closure exists for it). */
export async function currentSession(ctx: Ctx): Promise<CashSessionRecord | undefined> {
  const mine = (await db.cashSessions.where('shopId').equals(ctx.shopId).toArray()).filter((s) => s.openedBy === ctx.userId)
  const closed = new Set((await db.cashClosures.toArray()).map((c) => c.sessionId))
  return mine.filter((s) => !closed.has(s.id)).sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1))[0]
}

export async function openCashSession(ctx: Ctx, openingCash: number): Promise<CashSessionRecord> {
  need(ctx, 'sales.create')
  if (!Number.isInteger(openingCash) || openingCash < 0) throw new PaymentError('opening cash must be a whole number of FCFA')
  return db.transaction('rw', MONEY_TABLES, async () => {
    if (await currentSession(ctx)) throw new PaymentError('a cash session is already open')
    const a = actor(ctx)
    const s: CashSessionRecord = {
      id: a.newId(), tenantId: ctx.tenantId, shopId: ctx.shopId, openedBy: ctx.userId, openingCash, openedAt: a.nowIso,
    }
    await db.cashSessions.add(s)
    await queue('cash_sessions', s, s.id)
    return s
  })
}

export async function closeCashSession(ctx: Ctx, sessionId: string, counted: number) {
  need(ctx, 'sales.create')
  return db.transaction('rw', MONEY_TABLES, async () => {
    const session = await db.cashSessions.get(sessionId)
    if (!session) throw new PaymentError('session not found')
    if (await db.cashClosures.where('sessionId').equals(sessionId).first()) throw new PaymentError('this session is already closed')
    const txns = await db.transactions.where('shopId').equals(ctx.shopId).toArray()
    const r = buildClosure({ ...actor(ctx), session, txns, counted })
    await db.cashClosures.add(r.closure)
    // Recorded permanently, whether or not it balances. A difference is a flagged event.
    await queue('cash_session_closures', r.closure, r.closure.id)
    return r
  })
}

export async function recentClosures(): Promise<CashClosureRecord[]> {
  return (await db.cashClosures.toArray()).sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1)).slice(0, 20)
}
