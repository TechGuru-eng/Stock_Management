import Dexie, { type EntityTable } from 'dexie'
import type { StockMovement } from '../domain/inventory'
import type { CustomerEntryRecord, FinancialTxnRecord, SaleLineRecord, SaleRecord } from '../domain/pos'

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

export type MovementRec = StockMovement & { tenantId: string; unitCost?: number }

export interface CustomerRec {
  id: string
  tenantId: string
  name: string
  phone?: string
  creditLimit: number
  createdAt: string
}

export interface OutboxRec {
  id: string
  table: string
  op: 'insert'
  payload: unknown
  createdAt: string
  status: 'pending' | 'sending' | 'failed'
  attempts: number
  lastError?: string
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
  outbox!: EntityTable<OutboxRec, 'id'>
  meta!: EntityTable<MetaRec, 'key'>

  constructor() {
    super('stockcm')
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
