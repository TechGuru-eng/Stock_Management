import type { MovementRec, CustomerRec, ProductRec, UnitRec } from '../data/db'
import type { CustomerEntryRecord, FinancialTxnRecord, SaleLineRecord, SaleRecord } from '../domain/pos'

/** Tables that travel between devices, in dependency order (parents first). */
export const SYNC_TABLES = [
  'products',
  'product_units',
  'customers',
  'stock_movements',
  'sales',
  'sale_lines',
  'financial_transactions',
  'customer_account_entries',
  'payments',
  'payment_allocations',
  'expenses',
  'cash_sessions',
  'cash_session_closures',
  'suppliers',
  'purchases',
  'purchase_lines',
  'goods_receipts',
  'goods_receipt_lines',
  'supplier_account_entries',
  'sale_returns',
  'sale_return_lines',
  'approval_requests',
  'approval_decisions',
  'stock_counts',
  'stock_count_lines',
  'stock_count_decisions',
] as const
export type SyncTable = (typeof SYNC_TABLES)[number]

type Row = Record<string, unknown>
// Local records are loosely typed here on purpose: this file is the single place
// where device (camelCase) and server (snake_case) shapes meet.
type Local = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** Local record -> the columns the server accepts. Anything else (names, caches) stays on the device. */
export function toServer(table: string, p: Local): Row {
  switch (table) {
    case 'products':
      return {
        id: p.id, tenant_id: p.tenantId, name: p.name, barcode: p.barcode ?? null, sku: p.sku ?? null,
        base_unit: p.baseUnit, min_stock: p.minStock, tax_rate_bp: p.taxRateBp, is_service: p.isService,
        active: p.active, created_at: p.createdAt,
      }
    case 'product_edit':
    case 'unit_edit': {
      const snake: Record<string, string> = { minStock: 'min_stock', taxRateBp: 'tax_rate_bp', sellPrice: 'sell_price' }
      const conv = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [snake[k] ?? k, v]))
      return { id: p.id, tenant_id: p.tenantId, ...conv(p.changes as Record<string, unknown>), before: conv((p.before ?? {}) as Record<string, unknown>) }
    }
    case 'product_barcode':
      return { id: p.id, tenant_id: p.tenantId, barcode: p.barcode }
    case 'product_units':
      return {
        id: p.id, tenant_id: p.tenantId, product_id: p.productId, name: p.name, factor: p.factor,
        sell_price: p.sellPrice, is_base: p.isBase,
      }
    case 'customers':
      return {
        id: p.id, tenant_id: p.tenantId, name: p.name, phone: p.phone ?? null, credit_limit: p.creditLimit,
        created_at: p.createdAt,
      }
    case 'stock_movements':
      return {
        id: p.id, tenant_id: p.tenantId, shop_id: p.shopId, product_id: p.productId, quantity: p.quantity,
        movement_type: p.type, reason: p.reason ?? null,
        reference_type:
          p.type === 'sale' ? 'sale' : p.type === 'purchase_receipt' && p.referenceId ? 'receipt' : p.type === 'return_in' && p.referenceId ? 'return' : (p.type === 'transfer_in' || p.type === 'transfer_out') && p.referenceId ? 'transfer' : p.type === 'count_adjustment' && p.referenceId ? 'count' : null,
        reference_id: p.referenceId ?? null,
        unit_cost: p.unitCost ?? null, total_cost: p.totalCost ?? null, occurred_at: p.createdAt,
      }
    case 'sales':
      return {
        id: p.id, tenant_id: p.tenantId, shop_id: p.shopId, sale_number: p.saleNumber, customer_id: p.customerId ?? null,
        subtotal: p.subtotal, discount: p.discount, tax: p.tax, total: p.total, collected: p.collected,
        outstanding: p.outstanding, status: p.status, occurred_at: p.occurredAt,
      }
    case 'sale_lines':
      return {
        id: p.id, tenant_id: p.tenantId, sale_id: p.saleId, product_id: p.productId, unit_id: p.unitId,
        quantity: p.quantity, base_quantity: p.baseQuantity, unit_price: p.unitPrice, line_discount: p.lineDiscount,
        line_total: p.lineTotal, cost_of_goods: p.costOfGoods,
      }
    case 'financial_transactions':
      return {
        id: p.id, tenant_id: p.tenantId, shop_id: p.shopId, reference: p.reference, txn_type: p.txnType,
        amount: p.amount, method: p.method, verification: p.verification, customer_id: p.customerId ?? null,
        sale_id: p.saleId ?? null, return_id: p.returnId ?? null, description: p.description ?? null, occurred_at: p.occurredAt,
      }
    case 'customer_account_entries':
      return {
        id: p.id, tenant_id: p.tenantId, customer_id: p.customerId, amount: p.amount, kind: p.kind,
        sale_id: p.saleId ?? null, transaction_id: p.transactionId ?? null, return_id: p.returnId ?? null, occurred_at: p.occurredAt,
      }
    case 'payments':
      return {
        id: p.id, tenant_id: p.tenantId, customer_id: p.customerId, transaction_id: p.transactionId,
        method: p.method, amount: p.amount, created_at: p.occurredAt,
      }
    case 'payment_allocations':
      return { id: p.id, tenant_id: p.tenantId, payment_id: p.paymentId, sale_id: p.saleId, amount: p.amount }
    case 'expenses':
      return {
        id: p.id, tenant_id: p.tenantId, shop_id: p.shopId, category: p.category, amount: p.amount,
        method: p.method, description: p.description ?? null, occurred_at: p.occurredAt,
      }
    case 'cash_sessions':
      return {
        id: p.id, tenant_id: p.tenantId, shop_id: p.shopId, opening_cash: p.openingCash, opened_at: p.openedAt,
      }
    case 'cash_session_closures':
      return {
        id: p.id, tenant_id: p.tenantId, session_id: p.sessionId, expected_closing: p.expectedClosing,
        counted_closing: p.countedClosing, difference: p.difference, closed_at: p.closedAt,
      }
    case 'sale_returns':
      return {
        id: p.id, tenant_id: p.tenantId, shop_id: p.shopId, sale_id: p.saleId, kind: p.kind, reason: p.reason,
        total_value: p.totalValue, net_value: p.netValue, refunded_amount: p.refundedAmount, debt_reduced: p.debtReduced,
        refund_method: p.refundMethod ?? null, approved_by: p.approvedBy ?? null, occurred_at: p.occurredAt,
      }
    case 'sale_return_lines':
      return {
        id: p.id, tenant_id: p.tenantId, return_id: p.returnId, sale_line_id: p.saleLineId, product_id: p.productId,
        quantity: p.quantity, base_quantity: p.baseQuantity, value: p.value, net_value: p.netValue, restock: p.restock,
        cost_reversed: p.costReversed,
      }
    case 'approval_requests':
      return { id: p.id, tenant_id: p.tenantId, kind: p.kind, payload: p.payload, requested_at: p.requestedAt }
    case 'approval_decisions':
      return {
        id: p.id, tenant_id: p.tenantId, request_id: p.requestId, decision: p.decision, note: p.note ?? null,
        return_id: p.returnId ?? null, decided_at: p.decidedAt,
      }
    case 'stock_counts':
      return { id: p.id, tenant_id: p.tenantId, shop_id: p.shopId, name: p.name, blind: p.blind, started_at: p.startedAt }
    case 'stock_count_lines':
      return {
        id: p.id, tenant_id: p.tenantId, count_id: p.countId, product_id: p.productId, counted: p.counted, expected: p.expected,
        unit_cost: p.unitCost, counted_at: p.countedAt,
      }
    case 'stock_count_decisions':
      return { id: p.id, tenant_id: p.tenantId, count_id: p.countId, decision: p.decision, note: p.note ?? null, decided_at: p.decidedAt }
    case 'suppliers':
      return { id: p.id, tenant_id: p.tenantId, name: p.name, phone: p.phone ?? null, notes: p.notes ?? null, created_at: p.createdAt }
    case 'purchases':
      return {
        id: p.id, tenant_id: p.tenantId, shop_id: p.shopId, supplier_id: p.supplierId,
        invoice_number: p.invoiceNumber ?? null, ordered_at: p.orderedAt,
      }
    case 'purchase_lines':
      return {
        id: p.id, tenant_id: p.tenantId, purchase_id: p.purchaseId, product_id: p.productId,
        base_quantity: p.baseQuantity, total_cost: p.totalCost,
      }
    case 'goods_receipts':
      return { id: p.id, tenant_id: p.tenantId, purchase_id: p.purchaseId, received_at: p.receivedAt }
    case 'goods_receipt_lines':
      return {
        id: p.id, tenant_id: p.tenantId, receipt_id: p.receiptId, purchase_line_id: p.purchaseLineId,
        product_id: p.productId, base_quantity: p.baseQuantity, total_cost: p.totalCost,
      }
    case 'supplier_account_entries':
      return {
        id: p.id, tenant_id: p.tenantId, supplier_id: p.supplierId, amount: p.amount, kind: p.kind,
        purchase_id: p.purchaseId ?? null, receipt_id: p.receiptId ?? null, transaction_id: p.transactionId ?? null,
        occurred_at: p.occurredAt,
      }
    default:
      throw new Error(`unknown sync table ${table}`)
  }
}

const num = (v: unknown) => Number(v)
const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v)

/** Server row -> local record. */
export function fromServer(table: SyncTable, r: Local): Local {
  switch (table) {
    case 'products':
      return {
        id: r.id, tenantId: r.tenant_id, name: r.name, barcode: opt(r.barcode), sku: opt(r.sku), baseUnit: r.base_unit,
        minStock: num(r.min_stock), taxRateBp: num(r.tax_rate_bp), isService: r.is_service, active: r.active,
        createdAt: r.created_at,
      } satisfies ProductRec
    case 'product_units':
      return {
        id: r.id, tenantId: r.tenant_id, productId: r.product_id, name: r.name, factor: num(r.factor),
        sellPrice: num(r.sell_price), isBase: r.is_base,
      } satisfies UnitRec
    case 'customers':
      return {
        id: r.id, tenantId: r.tenant_id, name: r.name, phone: opt(r.phone), creditLimit: num(r.credit_limit),
        createdAt: r.created_at,
      } satisfies CustomerRec
    case 'stock_movements':
      return {
        id: r.id, tenantId: r.tenant_id, shopId: r.shop_id, productId: r.product_id, quantity: num(r.quantity),
        type: r.movement_type, reason: opt(r.reason), staffId: (r.staff_id as string) ?? '',
        deviceId: (r.device_id as string) ?? '', createdAt: r.occurred_at, referenceId: opt(r.reference_id),
        unitCost: r.unit_cost == null ? undefined : num(r.unit_cost),
        totalCost: r.total_cost == null ? undefined : num(r.total_cost),
      } satisfies MovementRec
    case 'sales':
      return {
        id: r.id, tenantId: r.tenant_id, shopId: r.shop_id, saleNumber: r.sale_number, customerId: opt(r.customer_id),
        cashierId: (r.cashier_id as string) ?? '', deviceId: (r.device_id as string) ?? '', subtotal: num(r.subtotal),
        discount: num(r.discount), tax: num(r.tax), total: num(r.total), collected: num(r.collected),
        outstanding: num(r.outstanding), status: r.status, occurredAt: r.occurred_at,
      } satisfies SaleRecord
    case 'sale_lines':
      return {
        id: r.id, tenantId: r.tenant_id, saleId: r.sale_id, productId: r.product_id,
        // Names are filled in from the local catalogue when the line is stored.
        productName: '', unitId: r.unit_id, unitName: '', quantity: num(r.quantity),
        baseQuantity: num(r.base_quantity), unitPrice: num(r.unit_price), lineDiscount: num(r.line_discount),
        lineTotal: num(r.line_total), costOfGoods: num(r.cost_of_goods),
      } satisfies SaleLineRecord
    case 'financial_transactions':
      return {
        id: r.id, tenantId: r.tenant_id, shopId: r.shop_id, reference: r.reference, txnType: r.txn_type,
        amount: num(r.amount), method: r.method, verification: r.verification, staffId: (r.staff_id as string) ?? '',
        deviceId: (r.device_id as string) ?? '', customerId: opt(r.customer_id), saleId: opt(r.sale_id),
        returnId: opt(r.return_id), description: opt(r.description), occurredAt: r.occurred_at,
      } satisfies FinancialTxnRecord
    case 'customer_account_entries':
      return {
        id: r.id, tenantId: r.tenant_id, customerId: r.customer_id, amount: num(r.amount), kind: r.kind,
        saleId: opt(r.sale_id), transactionId: opt(r.transaction_id), returnId: opt(r.return_id), occurredAt: r.occurred_at,
      } satisfies CustomerEntryRecord
    case 'payments':
      return {
        id: r.id, tenantId: r.tenant_id, customerId: r.customer_id, method: r.method, amount: num(r.amount),
        transactionId: r.transaction_id, occurredAt: r.created_at,
      }
    case 'payment_allocations':
      return { id: r.id, tenantId: r.tenant_id, paymentId: r.payment_id, saleId: r.sale_id, amount: num(r.amount) }
    case 'expenses':
      return {
        id: r.id, tenantId: r.tenant_id, shopId: r.shop_id, category: r.category, amount: num(r.amount),
        method: r.method, description: opt(r.description), staffId: (r.staff_id as string) ?? '', occurredAt: r.occurred_at,
      }
    case 'cash_sessions':
      return {
        id: r.id, tenantId: r.tenant_id, shopId: r.shop_id, openedBy: (r.opened_by as string) ?? '',
        openingCash: num(r.opening_cash), openedAt: r.opened_at,
      }
    case 'cash_session_closures':
      return {
        id: r.id, tenantId: r.tenant_id, sessionId: r.session_id, closedBy: (r.closed_by as string) ?? '',
        expectedClosing: num(r.expected_closing), countedClosing: num(r.counted_closing),
        difference: num(r.difference), closedAt: r.closed_at,
      }
    case 'sale_returns':
      return {
        id: r.id, tenantId: r.tenant_id, shopId: r.shop_id, saleId: r.sale_id, kind: r.kind, reason: r.reason,
        totalValue: num(r.total_value), netValue: num(r.net_value), refundedAmount: num(r.refunded_amount),
        debtReduced: num(r.debt_reduced), refundMethod: opt(r.refund_method), createdBy: (r.created_by as string) ?? '',
        approvedBy: opt(r.approved_by), occurredAt: r.occurred_at,
      }
    case 'sale_return_lines':
      return {
        id: r.id, tenantId: r.tenant_id, returnId: r.return_id, saleLineId: r.sale_line_id, productId: r.product_id,
        quantity: num(r.quantity), baseQuantity: num(r.base_quantity), value: num(r.value), netValue: num(r.net_value),
        restock: r.restock, costReversed: num(r.cost_reversed),
      }
    case 'approval_requests':
      return {
        id: r.id, tenantId: r.tenant_id, shopId: '', kind: r.kind, payload: r.payload,
        requestedBy: (r.requested_by as string) ?? '', requestedAt: r.requested_at,
      }
    case 'approval_decisions':
      return {
        id: r.id, tenantId: r.tenant_id, requestId: r.request_id, decidedBy: (r.decided_by as string) ?? '',
        decision: r.decision, note: opt(r.note), returnId: opt(r.return_id), decidedAt: r.decided_at,
      }
    case 'stock_counts':
      return { id: r.id, tenantId: r.tenant_id, shopId: r.shop_id, name: r.name, blind: Boolean(r.blind), startedBy: (r.started_by as string) ?? '', startedAt: r.started_at }
    case 'stock_count_lines':
      return {
        id: r.id, tenantId: r.tenant_id, countId: r.count_id, productId: r.product_id, counted: num(r.counted), expected: num(r.expected),
        unitCost: num(r.unit_cost), countedBy: (r.counted_by as string) ?? '', countedAt: r.counted_at,
      }
    case 'stock_count_decisions':
      return {
        id: r.id, tenantId: r.tenant_id, countId: r.count_id, decision: r.decision, note: opt(r.note), decidedBy: (r.decided_by as string) ?? '', decidedAt: r.decided_at,
      }
    case 'suppliers':
      return { id: r.id, tenantId: r.tenant_id, name: r.name, phone: opt(r.phone), notes: opt(r.notes), createdAt: r.created_at }
    case 'purchases':
      return {
        id: r.id, tenantId: r.tenant_id, shopId: r.shop_id, supplierId: r.supplier_id,
        invoiceNumber: opt(r.invoice_number), orderedAt: r.ordered_at,
      }
    case 'purchase_lines':
      return {
        id: r.id, tenantId: r.tenant_id, purchaseId: r.purchase_id, productId: r.product_id,
        baseQuantity: num(r.base_quantity), totalCost: num(r.total_cost),
      }
    case 'goods_receipts':
      return { id: r.id, tenantId: r.tenant_id, purchaseId: r.purchase_id, receivedBy: (r.received_by as string) ?? '', receivedAt: r.received_at }
    case 'goods_receipt_lines':
      return {
        id: r.id, tenantId: r.tenant_id, receiptId: r.receipt_id, purchaseLineId: r.purchase_line_id,
        productId: r.product_id, baseQuantity: num(r.base_quantity), totalCost: num(r.total_cost),
      }
    case 'supplier_account_entries':
      return {
        id: r.id, tenantId: r.tenant_id, supplierId: r.supplier_id, amount: num(r.amount), kind: r.kind,
        purchaseId: opt(r.purchase_id), receiptId: opt(r.receipt_id), transactionId: opt(r.transaction_id),
        occurredAt: r.occurred_at,
      }
  }
}
