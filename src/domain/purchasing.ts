import { assertPositiveXaf, assertXaf, roundXaf, sumXaf, type Xaf } from './money'
import { PaymentError } from './payments'
import type { StockMovement } from './inventory'
import type { FinancialTxnRecord } from './pos'

/**
 * Purchasing keeps THREE different events apart, because in a real shop they happen at
 * different times:
 *   1. the ORDER      - what we asked a supplier for. Changes nothing: no stock, no debt.
 *   2. the RECEIPT    - what physically arrived. Only this raises stock, and only this creates the debt.
 *   3. the PAYMENT    - money we paid the supplier. Lowers the debt; never touches stock.
 */

type PayMethod = 'cash' | 'mtn_momo' | 'orange_money'

interface Actor {
  newId: () => string
  tenantId: string
  shopId: string
  userId: string
  deviceId: string
  nowIso: string
}

export interface SupplierRecord {
  id: string
  tenantId: string
  name: string
  phone?: string
  notes?: string
  createdAt: string
}

export interface PurchaseRecord {
  id: string
  tenantId: string
  shopId: string
  supplierId: string
  invoiceNumber?: string
  orderedAt: string
}

export interface PurchaseLineRecord {
  id: string
  tenantId: string
  purchaseId: string
  productId: string
  /** Ordered quantity in BASE units. */
  baseQuantity: number
  /** Total agreed cost of the whole ordered quantity, in XAF. */
  totalCost: Xaf
}

export interface GoodsReceiptRecord {
  id: string
  tenantId: string
  purchaseId: string
  receivedBy: string
  receivedAt: string
}

export interface ReceiptLineRecord {
  id: string
  tenantId: string
  receiptId: string
  purchaseLineId: string
  productId: string
  baseQuantity: number
  /** The share of the line's cost that this delivery represents. */
  totalCost: Xaf
}

/** Positive = we owe the supplier more. Negative = we owe less. */
export interface SupplierEntryRecord {
  id: string
  tenantId: string
  supplierId: string
  amount: Xaf
  kind: 'purchase_credit' | 'payment' | 'return' | 'adjustment' | 'reversal'
  purchaseId?: string
  receiptId?: string
  transactionId?: string
  occurredAt: string
}

/* --------------------------------- order --------------------------------- */

export function buildPurchase(
  a: Actor & { supplierId: string; invoiceNumber?: string; lines: { productId: string; baseQuantity: number; totalCost: Xaf }[] },
): { purchase: PurchaseRecord; lines: PurchaseLineRecord[] } {
  if (a.lines.length === 0) throw new PaymentError('an order needs at least one product')
  const purchase: PurchaseRecord = {
    id: a.newId(), tenantId: a.tenantId, shopId: a.shopId, supplierId: a.supplierId,
    invoiceNumber: a.invoiceNumber?.trim() || undefined, orderedAt: a.nowIso,
  }
  return {
    purchase,
    lines: a.lines.map((l) => {
      if (!Number.isInteger(l.baseQuantity) || l.baseQuantity <= 0) throw new PaymentError('quantity must be a positive whole number')
      assertXaf(l.totalCost, 'cost')
      if (l.totalCost < 0) throw new PaymentError('cost cannot be negative')
      return { id: a.newId(), tenantId: a.tenantId, purchaseId: purchase.id, productId: l.productId, baseQuantity: l.baseQuantity, totalCost: l.totalCost }
    }),
  }
}

export type PurchaseStatus = 'ordered' | 'partially_received' | 'received'

export function receivedByLine(receiptLines: readonly ReceiptLineRecord[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of receiptLines) m.set(r.purchaseLineId, (m.get(r.purchaseLineId) ?? 0) + r.baseQuantity)
  return m
}

/** Derived from the receipts, never stored, so it cannot drift out of step with what really arrived. */
export function purchaseStatus(lines: readonly PurchaseLineRecord[], receiptLines: readonly ReceiptLineRecord[]): PurchaseStatus {
  const got = receivedByLine(receiptLines)
  const total = lines.reduce((t, l) => t + (got.get(l.id) ?? 0), 0)
  if (total === 0) return 'ordered'
  return lines.every((l) => (got.get(l.id) ?? 0) >= l.baseQuantity) ? 'received' : 'partially_received'
}

/** Cost of the first `q` units of a line. Using cumulative rounding makes the deliveries add up EXACTLY to the line cost. */
function costOfFirst(line: PurchaseLineRecord, q: number): Xaf {
  return q >= line.baseQuantity ? line.totalCost : roundXaf((line.totalCost * q) / line.baseQuantity)
}

/* -------------------------------- receipt -------------------------------- */

export interface ReceiptResult {
  receipt: GoodsReceiptRecord
  lines: ReceiptLineRecord[]
  movements: StockMovement[]
  /** The debt created by what arrived (and the part paid on the spot, if any). */
  entries: SupplierEntryRecord[]
  /** Only when part of the delivery was paid immediately. */
  payment?: FinancialTxnRecord
  receivedCost: Xaf
}

export function buildReceipt(
  a: Actor & {
    purchase: PurchaseRecord
    lines: readonly PurchaseLineRecord[]
    priorReceiptLines: readonly ReceiptLineRecord[]
    deliveries: readonly { purchaseLineId: string; baseQuantity: number }[]
    paidNow?: { amount: Xaf; method: PayMethod; reference: string }
  },
): ReceiptResult {
  const delivered = a.deliveries.filter((d) => d.baseQuantity > 0)
  if (delivered.length === 0) throw new PaymentError('nothing was received')
  const got = receivedByLine(a.priorReceiptLines)
  const receipt: GoodsReceiptRecord = {
    id: a.newId(), tenantId: a.tenantId, purchaseId: a.purchase.id, receivedBy: a.userId, receivedAt: a.nowIso,
  }

  const lines: ReceiptLineRecord[] = []
  const movements: StockMovement[] = []
  for (const d of delivered) {
    const line = a.lines.find((l) => l.id === d.purchaseLineId)
    if (!line) throw new PaymentError('unknown order line')
    if (!Number.isInteger(d.baseQuantity)) throw new PaymentError('quantity must be a whole number')
    const before = got.get(line.id) ?? 0
    if (before + d.baseQuantity > line.baseQuantity) {
      throw new PaymentError(`more than ordered: ${before + d.baseQuantity} received of ${line.baseQuantity}`)
    }
    got.set(line.id, before + d.baseQuantity)
    const cost = costOfFirst(line, before + d.baseQuantity) - costOfFirst(line, before)
    lines.push({
      id: a.newId(), tenantId: a.tenantId, receiptId: receipt.id, purchaseLineId: line.id, productId: line.productId,
      baseQuantity: d.baseQuantity, totalCost: cost,
    })
    movements.push({
      id: a.newId(), shopId: a.shopId, productId: line.productId, quantity: d.baseQuantity, type: 'purchase_receipt',
      staffId: a.userId, deviceId: a.deviceId, createdAt: a.nowIso, referenceId: receipt.id,
      unitCost: roundXaf(cost / d.baseQuantity), totalCost: cost,
    })
  }

  const receivedCost = sumXaf(lines.map((l) => l.totalCost))
  const entries: SupplierEntryRecord[] = []
  if (receivedCost > 0) {
    entries.push({
      id: a.newId(), tenantId: a.tenantId, supplierId: a.purchase.supplierId, amount: receivedCost, kind: 'purchase_credit',
      purchaseId: a.purchase.id, receiptId: receipt.id, occurredAt: a.nowIso,
    })
  }

  let payment: FinancialTxnRecord | undefined
  if (a.paidNow && a.paidNow.amount > 0) {
    assertPositiveXaf(a.paidNow.amount, 'payment')
    if (a.paidNow.amount > receivedCost) throw new PaymentError('cannot pay more than the value received')
    const p = buildSupplierPayment({
      ...a, supplierId: a.purchase.supplierId, amount: a.paidNow.amount, method: a.paidNow.method,
      reference: a.paidNow.reference, payable: receivedCost, purchaseId: a.purchase.id,
    })
    payment = p.transaction
    entries.push(p.entry)
  }
  return { receipt, lines, movements, entries, payment, receivedCost }
}

/* -------------------------------- payments -------------------------------- */

export function buildSupplierPayment(
  a: Actor & { supplierId: string; amount: Xaf; method: PayMethod; reference: string; payable: Xaf; purchaseId?: string },
): { transaction: FinancialTxnRecord; entry: SupplierEntryRecord } {
  assertPositiveXaf(a.amount, 'payment')
  if (a.amount > a.payable) throw new PaymentError('that is more than we owe this supplier')
  const txnId = a.newId()
  return {
    transaction: {
      id: txnId, tenantId: a.tenantId, shopId: a.shopId, reference: a.reference, txnType: 'supplier_payment',
      amount: -a.amount, method: a.method, verification: 'recorded', staffId: a.userId, deviceId: a.deviceId,
      occurredAt: a.nowIso,
    },
    entry: {
      id: a.newId(), tenantId: a.tenantId, supplierId: a.supplierId, amount: -a.amount, kind: 'payment',
      purchaseId: a.purchaseId, transactionId: txnId, occurredAt: a.nowIso,
    },
  }
}

/* -------------------------------- returns -------------------------------- */

/**
 * Goods sent back to a supplier: stock goes out, and the supplier credits us.
 * `removedValue` is the weighted-average cost taken out of stock; `creditValue` is what the
 * supplier agrees to credit (they can differ, e.g. a restocking fee).
 */
export function buildSupplierReturn(
  a: Actor & { supplierId: string; productId: string; baseQuantity: number; removedValue: Xaf; creditValue: Xaf; reason: string },
): { movement: StockMovement; entry: SupplierEntryRecord } {
  if (!a.reason.trim()) throw new PaymentError('a reason is required')
  if (!Number.isInteger(a.baseQuantity) || a.baseQuantity <= 0) throw new PaymentError('quantity must be a positive whole number')
  assertPositiveXaf(a.creditValue, 'credit')
  const id = a.newId()
  return {
    movement: {
      id, shopId: a.shopId, productId: a.productId, quantity: -a.baseQuantity, type: 'supplier_return', reason: a.reason.trim(),
      staffId: a.userId, deviceId: a.deviceId, createdAt: a.nowIso, referenceId: id,
      unitCost: roundXaf(a.removedValue / a.baseQuantity), totalCost: a.removedValue,
    },
    entry: {
      id: a.newId(), tenantId: a.tenantId, supplierId: a.supplierId, amount: -a.creditValue, kind: 'return', occurredAt: a.nowIso,
    },
  }
}

/* ------------------------------- statements ------------------------------- */

export const supplierBalance = (entries: readonly SupplierEntryRecord[]): Xaf => sumXaf(entries.map((e) => e.amount))

export interface StatementRow {
  entry: SupplierEntryRecord
  /** What we owed after this entry. */
  balance: Xaf
}

export function supplierStatement(entries: readonly SupplierEntryRecord[]): StatementRow[] {
  let running = 0
  return [...entries]
    .sort((a, b) => (a.occurredAt === b.occurredAt ? (a.id < b.id ? -1 : 1) : a.occurredAt < b.occurredAt ? -1 : 1))
    .map((entry) => ({ entry, balance: (running += entry.amount) }))
}
