import Dexie, { type EntityTable } from 'dexie'
import type { StockMovement } from '../domain/inventory'
import type { CustomerEntryRecord, FinancialTxnRecord, SaleLineRecord, SaleRecord } from '../domain/pos'
import type { AllocationRecord, CashClosureRecord, CashSessionRecord, ExpenseRecord, PaymentRecord } from '../domain/finance'
import type { ApprovalDecisionRecord, ApprovalRequestRecord, ReturnLineRecord, ReturnRecord } from '../domain/returns'
import type {
  GoodsReceiptRecord, PurchaseLineRecord, PurchaseRecord, ReceiptLineRecord, SupplierEntryRecord, SupplierRecord,
} from '../domain/purchasing'

export interface ProductRec {
  id: string
  tenantId: string
  name: string
  barcode?: string
  sku?: string
  baseUnit: string
  minStock: number
  taxRateBp: number
  isService: boolean
  active: boolean
  createdAt: string
}

export interface UnitRec {
  id: string
  tenantId: string
  productId: string
  name: string
  /** Base units per this unit. */
  factor: number
  sellPrice: number
  isBase: boolean
}

/** Weighted-average state of one product in one shop. `quantity` is the stock on hand. */
export interface CostRec {
  key: string
  shopId: string
  productId: string
  quantity: number
  value: number
  lastUnitCost: number
}

export type MovementRec = StockMovement & { tenantId: string }

export interface CustomerRec {
  id: string
  tenantId: string
  name: string
  phone?: string
  creditLimit: number
  createdAt: string
}

/**
 * One row per record to upload. Rows of the same business event (a sale and its
 * lines, stock movements, payments and debt) share a `groupId` and are uploaded
 * together, atomically, in `seq` order.
 *  - pending : waiting to upload (possibly retrying after a network error)
 *  - rejected: the server refused it; needs attention, never retried automatically
 *  - conflict: clashes with data from another device; needs a decision
 */
export interface OutboxRec {
  seq?: number
  id: string
  groupId: string
  table: string
  payload: unknown
  createdAt: string
  status: 'pending' | 'rejected' | 'conflict'
  attempts: number
  nextAttemptAt?: string
  lastError?: string
  /** The person at the till when this was recorded (differs from the signed-in session on a shared device). */
  actorId?: string
}

/** History of every upload attempt, kept so failures can be investigated. */
export interface SyncLogRec {
  id?: number
  groupId: string
  at: string
  outcome: 'ok' | 'network' | 'rejected' | 'conflict'
  message?: string
}

export interface MetaRec {
  key: string
  value: unknown
}

class StockCmDb extends Dexie {
  products!: EntityTable<ProductRec, 'id'>
  units!: EntityTable<UnitRec, 'id'>
  costs!: EntityTable<CostRec, 'key'>
  movements!: EntityTable<MovementRec, 'id'>
  sales!: EntityTable<SaleRecord, 'id'>
  saleLines!: EntityTable<SaleLineRecord, 'id'>
  transactions!: EntityTable<FinancialTxnRecord, 'id'>
  customers!: EntityTable<CustomerRec, 'id'>
  customerEntries!: EntityTable<CustomerEntryRecord, 'id'>
  payments!: EntityTable<PaymentRecord, 'id'>
  allocations!: EntityTable<AllocationRecord, 'id'>
  expenses!: EntityTable<ExpenseRecord, 'id'>
  cashSessions!: EntityTable<CashSessionRecord, 'id'>
  cashClosures!: EntityTable<CashClosureRecord, 'id'>
  suppliers!: EntityTable<SupplierRecord, 'id'>
  purchases!: EntityTable<PurchaseRecord, 'id'>
  purchaseLines!: EntityTable<PurchaseLineRecord, 'id'>
  receipts!: EntityTable<GoodsReceiptRecord, 'id'>
  receiptLines!: EntityTable<ReceiptLineRecord, 'id'>
  supplierEntries!: EntityTable<SupplierEntryRecord, 'id'>
  saleReturns!: EntityTable<ReturnRecord, 'id'>
  returnLines!: EntityTable<ReturnLineRecord, 'id'>
  approvalRequests!: EntityTable<ApprovalRequestRecord, 'id'>
  approvalDecisions!: EntityTable<ApprovalDecisionRecord, 'id'>
  outbox!: EntityTable<OutboxRec, 'seq'>
  syncLog!: EntityTable<SyncLogRec, 'id'>
  meta!: EntityTable<MetaRec, 'key'>

  constructor(name = 'stockcm') {
    super(name)
    this.version(1).stores({
      products: 'id, tenantId, name, barcode, sku',
      units: 'id, productId',
      costs: 'key, shopId, productId',
      movements: 'id, shopId, productId, referenceId, createdAt',
      sales: 'id, shopId, occurredAt, customerId, saleNumber',
      saleLines: 'id, saleId, productId',
      transactions: 'id, shopId, saleId, occurredAt',
      customers: 'id, tenantId, name, phone',
      customerEntries: 'id, customerId, saleId',
      outbox: 'id, status, createdAt',
      meta: 'key',
    })
    // Dexie cannot change a primary key in place: drop and recreate the outbox.
    // (Pre-release only: no production data existed in the old outbox.)
    this.version(2).stores({ outbox: null })
    this.version(3).stores({
      outbox: '++seq, &id, groupId, status',
      syncLog: '++id, groupId, at',
    })
    this.version(4).stores({
      payments: 'id, customerId',
      allocations: 'id, paymentId, saleId',
      expenses: 'id, shopId, occurredAt',
      cashSessions: 'id, shopId, openedAt',
      cashClosures: 'id, sessionId',
    })
    this.version(5).stores({
      suppliers: 'id, name',
      purchases: 'id, supplierId, orderedAt',
      purchaseLines: 'id, purchaseId',
      receipts: 'id, purchaseId',
      receiptLines: 'id, receiptId, purchaseLineId',
      supplierEntries: 'id, supplierId',
    })
    this.version(6).stores({
      saleReturns: 'id, saleId, occurredAt',
      returnLines: 'id, returnId, saleLineId',
      approvalRequests: 'id, requestedAt',
      approvalDecisions: 'id, requestId',
    })
  }
}

export const db = new StockCmDb()

export function newId(): string {
  return crypto.randomUUID()
}

export function deviceId(): string {
  const k = 'stockcm.deviceId'
  try {
    let v = localStorage.getItem(k)
    if (!v) {
      v = newId()
      localStorage.setItem(k, v)
    }
    return v
  } catch {
    return newId()
  }
}
