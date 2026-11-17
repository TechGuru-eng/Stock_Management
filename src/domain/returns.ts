import { roundXaf, sumXaf, type Xaf } from './money'
import { PaymentError } from './payments'
import type { StockMovement } from './inventory'
import type { CustomerEntryRecord, FinancialTxnRecord, SaleLineRecord, SaleRecord } from './pos'

/**
 * A return NEVER edits the sale. It is a new record that points back at it, and it does up to
 * three separate things, each as its own ledger record:
 *   1. puts goods back in stock (only if they are fit to resell),
 *   2. first reduces what the customer still owes on that sale,
 *   3. refunds money only for the rest, and only up to what the customer really paid.
 */

type RefundMethod = 'cash' | 'mtn_momo' | 'orange_money'

interface Actor {
  newId: () => string
  tenantId: string
  shopId: string
  userId: string
  deviceId: string
  nowIso: string
}

export interface ReturnRecord {
  id: string
  tenantId: string
  shopId: string
  saleId: string
  kind: 'return' | 'cancellation'
  reason: string
  /** Everything handed back, including tax. */
  totalValue: Xaf
  /** The part of it that was revenue (excluding tax). */
  netValue: Xaf
  /** Money paid out to the customer. */
  refundedAmount: Xaf
  /** Debt written off because the goods came back. */
  debtReduced: Xaf
  refundMethod?: RefundMethod
  createdBy: string
  approvedBy?: string
  occurredAt: string
}

export interface ReturnLineRecord {
  id: string
  tenantId: string
  returnId: string
  saleLineId: string
  productId: string
  /** In the unit it was sold in. */
  quantity: number
  baseQuantity: number
  value: Xaf
  netValue: Xaf
  restock: boolean
  /** Cost of goods put back into stock (0 if not restocked). */
  costReversed: Xaf
}

export interface ReturnRequestLine {
  saleLineId: string
  quantity: number
  /** false = the goods are damaged or unsellable, so they do not go back into stock. */
  restock: boolean
}

export interface ReturnRequest {
  kind: 'return' | 'cancellation'
  reason: string
  refundMethod?: RefundMethod
  lines: ReturnRequestLine[]
}

const EPS = 1e-9
const q3 = (n: number) => Math.round(n * 1000) / 1000

/** Share of a total for the first `q` of `sold` units. Cumulative rounding makes partial returns add up exactly. */
function firstShare(total: number, q: number, sold: number): number {
  return q >= sold - EPS ? total : roundXaf((total * q) / sold)
}

export const soldNet = (l: SaleLineRecord): Xaf => roundXaf(l.unitPrice * l.quantity) - l.lineDiscount

/** What can still be returned per sale line (in the unit sold). */
export function returnableQuantities(lines: readonly SaleLineRecord[], prior: readonly ReturnLineRecord[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const l of lines) {
    const back = prior.filter((p) => p.saleLineId === l.id).reduce((t, p) => t + p.quantity, 0)
    out.set(l.id, q3(l.quantity - back))
  }
  return out
}

export interface ReturnResult {
  ret: ReturnRecord
  lines: ReturnLineRecord[]
  movements: StockMovement[]
  transaction?: FinancialTxnRecord
  entry?: CustomerEntryRecord
}

export function buildReturn(
  a: Actor & {
    sale: SaleRecord
    saleLines: readonly SaleLineRecord[]
    priorLines: readonly ReturnLineRecord[]
    request: ReturnRequest
    /** What the customer still owes on this sale after repayments and earlier returns. */
    openOnSale: Xaf
    /** Money the customer has really paid for this sale (at the till or by later repayment) minus refunds already paid. */
    refundableMoney: Xaf
    reference: string
    approvedBy?: string
  },
): ReturnResult {
  const req = a.request
  if (!req.reason.trim()) throw new PaymentError('a reason is required')
  if (req.lines.length === 0) throw new PaymentError('choose what is being returned')
  const remaining = returnableQuantities(a.saleLines, a.priorLines)

  const retId = a.newId()
  const lines: ReturnLineRecord[] = []
  const movements: StockMovement[] = []

  for (const rl of req.lines) {
    const line = a.saleLines.find((l) => l.id === rl.saleLineId)
    if (!line) throw new PaymentError('that item is not on this sale')
    if (!(rl.quantity > 0)) throw new PaymentError('quantity must be greater than zero')
    const left = remaining.get(line.id) ?? 0
    if (rl.quantity > left + EPS) throw new PaymentError(`more than was sold: ${rl.quantity} of ${left} left`)

    const before = q3(line.quantity - left)
    const after = q3(before + rl.quantity)
    const net = soldNet(line)
    const value = firstShare(line.lineTotal, after, line.quantity) - firstShare(line.lineTotal, before, line.quantity)
    const netValue = firstShare(net, after, line.quantity) - firstShare(net, before, line.quantity)
    const base = firstShare(line.baseQuantity, after, line.quantity) - firstShare(line.baseQuantity, before, line.quantity)
    const cost = rl.restock ? firstShare(line.costOfGoods, after, line.quantity) - firstShare(line.costOfGoods, before, line.quantity) : 0

    lines.push({
      id: a.newId(), tenantId: a.tenantId, returnId: retId, saleLineId: line.id, productId: line.productId,
      quantity: rl.quantity, baseQuantity: base, value, netValue, restock: rl.restock, costReversed: cost,
    })
    if (rl.restock && base > 0) {
      movements.push({
        id: a.newId(), shopId: a.shopId, productId: line.productId, quantity: base, type: 'return_in', reason: req.reason.trim(),
        staffId: a.userId, deviceId: a.deviceId, createdAt: a.nowIso, referenceId: retId,
        unitCost: roundXaf(cost / base), totalCost: cost,
      })
    }
  }

  if (req.kind === 'cancellation') {
    for (const l of a.saleLines) {
      const left = remaining.get(l.id) ?? 0
      const taking = lines.filter((x) => x.saleLineId === l.id).reduce((t, x) => t + x.quantity, 0)
      if (q3(left - taking) > EPS) throw new PaymentError('a cancellation must return everything on the sale')
    }
  }

  const totalValue = sumXaf(lines.map((l) => l.value))
  const netValue = sumXaf(lines.map((l) => l.netValue))
  const debtReduced = a.sale.customerId ? Math.min(totalValue, Math.max(a.openOnSale, 0)) : 0
  const money = totalValue - debtReduced
  if (money > 0) {
    if (!req.refundMethod) throw new PaymentError('choose how the money is paid back')
    if (money > a.refundableMoney) throw new PaymentError('that refund is more than the customer paid')
  }

  const ret: ReturnRecord = {
    id: retId, tenantId: a.tenantId, shopId: a.shopId, saleId: a.sale.id, kind: req.kind, reason: req.reason.trim(),
    totalValue, netValue, refundedAmount: money, debtReduced, refundMethod: money > 0 ? req.refundMethod : undefined,
    createdBy: a.userId, approvedBy: a.approvedBy, occurredAt: a.nowIso,
  }
  return {
    ret, lines, movements,
    transaction: money > 0
      ? {
          id: a.newId(), tenantId: a.tenantId, shopId: a.shopId, reference: a.reference, txnType: 'refund', amount: -money,
          method: req.refundMethod!, verification: 'recorded', staffId: a.userId, deviceId: a.deviceId,
          customerId: a.sale.customerId, saleId: a.sale.id, returnId: retId, description: req.reason.trim(), occurredAt: a.nowIso,
        }
      : undefined,
    entry: debtReduced > 0
      ? {
          id: a.newId(), tenantId: a.tenantId, customerId: a.sale.customerId!, amount: -debtReduced, kind: 'reversal',
          saleId: a.sale.id, returnId: retId, occurredAt: a.nowIso,
        }
      : undefined,
  }
}

/** Every line, everything still left: what a cancellation returns. */
export function fullReturn(lines: readonly SaleLineRecord[], prior: readonly ReturnLineRecord[], restock = true): ReturnRequestLine[] {
  const left = returnableQuantities(lines, prior)
  return lines.filter((l) => (left.get(l.id) ?? 0) > EPS).map((l) => ({ saleLineId: l.id, quantity: left.get(l.id)!, restock }))
}

export type SaleReturnStatus = 'completed' | 'partially_returned' | 'returned' | 'cancelled'

/** Derived from the returns, never stored: the sale record itself stays as it was. */
export function saleReturnStatus(sale: SaleRecord, returns: readonly ReturnRecord[]): SaleReturnStatus {
  const mine = returns.filter((r) => r.saleId === sale.id)
  if (mine.length === 0) return 'completed'
  if (mine.some((r) => r.kind === 'cancellation')) return 'cancelled'
  return sumXaf(mine.map((r) => r.totalValue)) >= sale.total ? 'returned' : 'partially_returned'
}

/* -------------------------------- approvals -------------------------------- */

export interface ApprovalRequestRecord {
  id: string
  tenantId: string
  shopId: string
  /** Matches the server list: 'refund' for a return, 'reversal' for a cancellation. */
  kind: 'refund' | 'reversal'
  payload: { saleId: string; request: ReturnRequest }
  requestedBy: string
  requestedAt: string
}

export interface ApprovalDecisionRecord {
  id: string
  tenantId: string
  requestId: string
  decidedBy: string
  decision: 'approved' | 'rejected'
  note?: string
  returnId?: string
  decidedAt: string
}

export function buildApprovalRequest(a: Actor & { saleId: string; request: ReturnRequest }): ApprovalRequestRecord {
  if (!a.request.reason.trim()) throw new PaymentError('a reason is required')
  if (a.request.lines.length === 0) throw new PaymentError('choose what is being returned')
  return {
    id: a.newId(), tenantId: a.tenantId, shopId: a.shopId, kind: a.request.kind === 'cancellation' ? 'reversal' : 'refund',
    payload: { saleId: a.saleId, request: a.request }, requestedBy: a.userId, requestedAt: a.nowIso,
  }
}

export function buildDecision(a: Actor & { requestId: string; decision: 'approved' | 'rejected'; note?: string; returnId?: string }): ApprovalDecisionRecord {
  if (a.decision === 'rejected' && !a.note?.trim()) throw new PaymentError('say why the request is rejected')
  return {
    id: a.newId(), tenantId: a.tenantId, requestId: a.requestId, decidedBy: a.userId, decision: a.decision,
    note: a.note?.trim() || undefined, returnId: a.returnId, decidedAt: a.nowIso,
  }
}

export function pendingRequests(requests: readonly ApprovalRequestRecord[], decisions: readonly ApprovalDecisionRecord[]): ApprovalRequestRecord[] {
  const decided = new Set(decisions.map((d) => d.requestId))
  return requests.filter((r) => !decided.has(r.id))
}
