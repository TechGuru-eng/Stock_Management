import { assertPositiveXaf, type Xaf } from './money'
import { expectedClosing, reconcile, type CashSessionTotals, type Reconciliation } from './cash'
import { allocateRepayment, PaymentError, type Allocation, type OpenSale } from './payments'
import type { CustomerEntryRecord, FinancialTxnRecord } from './pos'

type CashlessMethod = 'cash' | 'mtn_momo' | 'orange_money'

interface Actor {
  newId: () => string
  tenantId: string
  shopId: string
  userId: string
  deviceId: string
  nowIso: string
}

/* ------------------------------ debt repayment ------------------------------ */

export interface PaymentRecord {
  id: string
  tenantId: string
  customerId: string
  method: CashlessMethod
  amount: Xaf
  transactionId: string
  occurredAt: string
}

export interface AllocationRecord {
  id: string
  tenantId: string
  paymentId: string
  saleId: string
  amount: Xaf
}

export interface RepaymentResult {
  payment: PaymentRecord
  allocations: AllocationRecord[]
  transaction: FinancialTxnRecord
  entry: CustomerEntryRecord
}

/**
 * A customer pays part or all of what they owe. The ORIGINAL sales are never touched:
 * the repayment is a new money entry, new allocations to the sales it settles, and a
 * negative customer-account entry that lowers the balance.
 */
export function buildRepayment(
  a: Actor & {
    customerId: string
    method: CashlessMethod
    amount: Xaf
    reference: string
    openSales: readonly OpenSale[]
    explicit?: readonly Allocation[]
  },
): RepaymentResult {
  assertPositiveXaf(a.amount, 'repayment')
  const allocs = allocateRepayment(a.amount, a.openSales, a.explicit)

  const txnId = a.newId()
  const paymentId = a.newId()
  const transaction: FinancialTxnRecord = {
    id: txnId, tenantId: a.tenantId, shopId: a.shopId, reference: a.reference, txnType: 'debt_repayment',
    amount: a.amount, method: a.method,
    // Entered by hand: recorded, never provider-verified.
    verification: 'recorded',
    staffId: a.userId, deviceId: a.deviceId, customerId: a.customerId, occurredAt: a.nowIso,
  }
  return {
    transaction,
    payment: {
      id: paymentId, tenantId: a.tenantId, customerId: a.customerId, method: a.method, amount: a.amount,
      transactionId: txnId, occurredAt: a.nowIso,
    },
    allocations: allocs.map((x) => ({ id: a.newId(), tenantId: a.tenantId, paymentId, saleId: x.saleId, amount: x.amount })),
    entry: {
      id: a.newId(), tenantId: a.tenantId, customerId: a.customerId, amount: -a.amount, kind: 'repayment',
      transactionId: txnId, occurredAt: a.nowIso,
    },
  }
}

/** Outstanding amount per sale = what was left on credit minus what repayments have been allocated to it. */
export function openSalesOf(
  sales: readonly { id: string; occurredAt: string; outstanding: Xaf }[],
  allocations: readonly { saleId: string; amount: Xaf }[],
): OpenSale[] {
  const paid = new Map<string, Xaf>()
  for (const al of allocations) paid.set(al.saleId, (paid.get(al.saleId) ?? 0) + al.amount)
  return sales
    .map((s) => ({ saleId: s.id, createdAt: s.occurredAt, outstanding: s.outstanding - (paid.get(s.id) ?? 0) }))
    .filter((s) => s.outstanding > 0)
}

/* --------------------------------- expenses --------------------------------- */

export type ExpenseCategory =
  | 'rent' | 'electricity' | 'water' | 'salaries' | 'transport' | 'internet' | 'maintenance' | 'deliveries' | 'other'

export const expenseCategories: readonly ExpenseCategory[] = [
  'rent', 'electricity', 'water', 'salaries', 'transport', 'internet', 'maintenance', 'deliveries', 'other',
]

export interface ExpenseRecord {
  id: string
  tenantId: string
  shopId: string
  category: ExpenseCategory
  amount: Xaf
  method: CashlessMethod
  description?: string
  staffId: string
  occurredAt: string
}

/**
 * An expense is ONE record plus ONE ledger entry linking to it. Reports sum the
 * expense records, never the ledger as well, so an expense is never counted twice.
 */
export function buildExpense(
  a: Actor & { category: ExpenseCategory; amount: Xaf; method: CashlessMethod; description?: string; reference: string },
): { expense: ExpenseRecord; transaction: FinancialTxnRecord } {
  assertPositiveXaf(a.amount, 'expense')
  if (!expenseCategories.includes(a.category)) throw new PaymentError('unknown expense category')
  const expense: ExpenseRecord = {
    id: a.newId(), tenantId: a.tenantId, shopId: a.shopId, category: a.category, amount: a.amount,
    method: a.method, description: a.description?.trim() || undefined, staffId: a.userId, occurredAt: a.nowIso,
  }
  return {
    expense,
    transaction: {
      id: a.newId(), tenantId: a.tenantId, shopId: a.shopId, reference: a.reference, txnType: 'expense',
      amount: -a.amount, method: a.method, verification: 'recorded', staffId: a.userId, deviceId: a.deviceId,
      description: a.description?.trim() || expense.category, occurredAt: a.nowIso,
    },
  }
}

/* --------------------------- till deposits and withdrawals -------------------------- */

export function buildCashMovement(
  a: Actor & { kind: 'cash_deposit' | 'cash_withdrawal'; amount: Xaf; reason: string; reference: string },
): FinancialTxnRecord {
  assertPositiveXaf(a.amount, 'amount')
  if (!a.reason.trim()) throw new PaymentError('a reason is required')
  return {
    id: a.newId(), tenantId: a.tenantId, shopId: a.shopId, reference: a.reference, txnType: a.kind,
    amount: a.kind === 'cash_deposit' ? a.amount : -a.amount, method: 'cash', verification: 'recorded',
    staffId: a.userId, deviceId: a.deviceId, description: a.reason.trim(), occurredAt: a.nowIso,
  }
}

/* ------------------------------- cash sessions ------------------------------- */

export interface CashSessionRecord {
  id: string
  tenantId: string
  shopId: string
  openedBy: string
  openingCash: Xaf
  openedAt: string
}

/** Written once when the session is closed; the difference is recorded permanently. */
export interface CashClosureRecord {
  id: string
  tenantId: string
  sessionId: string
  closedBy: string
  expectedClosing: Xaf
  countedClosing: Xaf
  difference: Xaf
  closedAt: string
}

/** Everything that moved the till during a session, from the money ledger (cash only). */
export function sessionTotals(
  session: CashSessionRecord,
  txns: readonly FinancialTxnRecord[],
  until: string,
): CashSessionTotals {
  const totals: CashSessionTotals = {
    opening: session.openingCash, cashSales: 0, cashRepayments: 0, cashDeposits: 0,
    cashRefunds: 0, cashExpenses: 0, cashWithdrawals: 0, supplierPayments: 0,
  }
  for (const t of txns) {
    if (t.method !== 'cash' || t.shopId !== session.shopId || t.staffId !== session.openedBy) continue
    if (t.occurredAt < session.openedAt || t.occurredAt > until) continue
    switch (t.txnType) {
      case 'sale_collection': totals.cashSales += t.amount; break
      case 'debt_repayment': totals.cashRepayments += t.amount; break
      case 'cash_deposit': totals.cashDeposits += t.amount; break
      case 'refund': totals.cashRefunds += -t.amount; break
      case 'expense': totals.cashExpenses += -t.amount; break
      case 'cash_withdrawal': totals.cashWithdrawals += -t.amount; break
      case 'supplier_payment': totals.supplierPayments += -t.amount; break
      default: break
    }
  }
  return totals
}

export function buildClosure(
  a: Actor & { session: CashSessionRecord; txns: readonly FinancialTxnRecord[]; counted: Xaf },
): { closure: CashClosureRecord; reconciliation: Reconciliation; totals: CashSessionTotals } {
  const totals = sessionTotals(a.session, a.txns, a.nowIso)
  const reconciliation = reconcile(totals, a.counted)
  return {
    totals,
    reconciliation,
    closure: {
      id: a.newId(), tenantId: a.tenantId, sessionId: a.session.id, closedBy: a.userId,
      expectedClosing: reconciliation.expected, countedClosing: a.counted, difference: reconciliation.difference,
      closedAt: a.nowIso,
    },
  }
}

export { expectedClosing }
