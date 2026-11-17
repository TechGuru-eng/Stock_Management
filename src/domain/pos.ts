import { issue, type CostState, emptyCostState } from './costing'
import { roundXaf, sumXaf, assertXaf, type Xaf } from './money'
import { checkOversell, type OversellPolicy, type StockMovement } from './inventory'
import { PaymentError, settleSale, type PaymentInput, type PaymentMethod, type VerificationStatus } from './payments'
import { toBaseQuantity } from './units'
import { discountNeedsApproval, type Role } from './permissions'

export interface CartLine {
  productId: string
  productName: string
  unitId: string
  unitName: string
  /** Base units per sold unit (carton = 24). */
  factor: number
  unitPrice: Xaf
  /** Quantity in the SOLD unit (may be fractional for kg, litre, metre). */
  quantity: number
  /** Discount in XAF on this line. */
  lineDiscount: Xaf
  taxRateBp: number
  isService: boolean
}

export interface LineTotals {
  gross: Xaf
  net: Xaf
  tax: Xaf
}

/** Prices are exclusive of tax when a rate is set; the tax is added on top of the discounted line. */
export function lineTotals(line: CartLine): LineTotals {
  assertXaf(line.unitPrice, 'unit price')
  assertXaf(line.lineDiscount, 'discount')
  const gross = roundXaf(line.unitPrice * line.quantity)
  if (line.lineDiscount < 0 || line.lineDiscount > gross) {
    throw new PaymentError('discount cannot be negative or exceed the line amount')
  }
  const net = gross - line.lineDiscount
  const tax = roundXaf((net * line.taxRateBp) / 10000)
  return { gross, net, tax }
}

export interface CartTotals {
  subtotal: Xaf
  discount: Xaf
  tax: Xaf
  total: Xaf
}

export function cartTotals(lines: readonly CartLine[]): CartTotals {
  const parts = lines.map(lineTotals)
  const subtotal = sumXaf(parts.map((p) => p.gross))
  const discount = sumXaf(lines.map((l) => l.lineDiscount))
  const tax = sumXaf(parts.map((p) => p.tax))
  return { subtotal, discount, tax, total: subtotal - discount + tax }
}

/* ------------------------------ checkout ------------------------------ */

export interface SaleRecord {
  id: string
  tenantId: string
  shopId: string
  saleNumber: string
  customerId?: string
  cashierId: string
  deviceId: string
  subtotal: Xaf
  discount: Xaf
  tax: Xaf
  total: Xaf
  collected: Xaf
  outstanding: Xaf
  status: 'completed'
  occurredAt: string
}

export interface SaleLineRecord {
  id: string
  tenantId: string
  saleId: string
  productId: string
  productName: string
  unitId: string
  unitName: string
  quantity: number
  baseQuantity: number
  unitPrice: Xaf
  lineDiscount: Xaf
  lineTotal: Xaf
  costOfGoods: Xaf
}

export interface FinancialTxnRecord {
  id: string
  tenantId: string
  shopId: string
  reference: string
  txnType: 'sale_collection'
  amount: Xaf
  method: Exclude<PaymentMethod, 'credit'>
  verification: VerificationStatus
  staffId: string
  deviceId: string
  customerId?: string
  saleId: string
  occurredAt: string
}

export interface CustomerEntryRecord {
  id: string
  tenantId: string
  customerId: string
  amount: Xaf
  kind: 'sale_credit'
  saleId: string
  occurredAt: string
}

export interface CheckoutInput {
  newId: () => string
  tenantId: string
  shopId: string
  userId: string
  deviceId: string
  role: Role
  saleNumber: string
  nowIso: string
  lines: readonly CartLine[]
  payments: readonly PaymentInput[]
  customer?: { id: string; creditLimit: Xaf; balance: Xaf }
  /** Current weighted-average state per product, keyed by productId. */
  costStates: Readonly<Record<string, CostState>>
  oversellPolicy: OversellPolicy
}

export interface CheckoutResult {
  sale: SaleRecord
  lines: SaleLineRecord[]
  movements: StockMovement[]
  transactions: FinancialTxnRecord[]
  customerEntry?: CustomerEntryRecord
  newCostStates: Record<string, CostState>
  /** Products sold beyond the stock the device shows: a manager must review. */
  oversoldProductIds: string[]
}

/**
 * Pure: turns a cart and its payments into every record a sale produces.
 * Nothing here touches a database, so the same logic can validate a synced sale on the server.
 */
export function buildSale(input: CheckoutInput): CheckoutResult {
  if (input.lines.length === 0) throw new PaymentError('the cart is empty')

  for (const l of input.lines) {
    const { gross } = lineTotals(l)
    if (discountNeedsApproval(gross, l.lineDiscount, input.role)) {
      throw new PaymentError(`discount on ${l.productName} needs manager approval`)
    }
  }

  const totals = cartTotals(input.lines)
  const settlement = settleSale(totals.total, input.payments, { hasCustomer: Boolean(input.customer) })

  if (settlement.outstanding > 0) {
    const c = input.customer!
    if (c.balance + settlement.outstanding > c.creditLimit) {
      throw new PaymentError('customer credit limit would be exceeded')
    }
  }

  const saleId = input.newId()
  const newCostStates: Record<string, CostState> = { ...input.costStates }
  const movements: StockMovement[] = []
  const oversold = new Set<string>()
  const lineRecords: SaleLineRecord[] = []

  for (const l of input.lines) {
    const { net } = lineTotals(l)
    const baseQuantity = toBaseQuantity(l.quantity, { id: l.unitId, name: l.unitName, factor: l.factor, price: l.unitPrice })
    let cogs = 0

    if (!l.isService) {
      const state = newCostStates[l.productId] ?? emptyCostState
      const decision = checkOversell(state.quantity, baseQuantity, input.oversellPolicy)
      if (!decision.allowed) throw new PaymentError(`not enough stock for ${l.productName}`)
      if (decision.flagged) oversold.add(l.productId)

      const issued = issue(state, baseQuantity)
      newCostStates[l.productId] = issued.state
      cogs = issued.cogs
      movements.push({
        id: input.newId(),
        shopId: input.shopId,
        productId: l.productId,
        quantity: -baseQuantity,
        type: 'sale',
        staffId: input.userId,
        deviceId: input.deviceId,
        createdAt: input.nowIso,
        referenceId: saleId,
      })
    }

    lineRecords.push({
      id: input.newId(),
      tenantId: input.tenantId,
      saleId,
      productId: l.productId,
      productName: l.productName,
      unitId: l.unitId,
      unitName: l.unitName,
      quantity: l.quantity,
      baseQuantity,
      unitPrice: l.unitPrice,
      lineDiscount: l.lineDiscount,
      lineTotal: net + roundXaf((net * l.taxRateBp) / 10000),
      costOfGoods: cogs,
    })
  }

  const sale: SaleRecord = {
    id: saleId,
    tenantId: input.tenantId,
    shopId: input.shopId,
    saleNumber: input.saleNumber,
    customerId: input.customer?.id,
    cashierId: input.userId,
    deviceId: input.deviceId,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total,
    collected: settlement.collected,
    outstanding: settlement.outstanding,
    status: 'completed',
    occurredAt: input.nowIso,
  }

  const transactions: FinancialTxnRecord[] = (['cash', 'mtn_momo', 'orange_money'] as const)
    .filter((m) => settlement.byMethod[m] > 0)
    .map((m) => ({
      id: input.newId(),
      tenantId: input.tenantId,
      shopId: input.shopId,
      reference: `${input.saleNumber}-${m}`,
      txnType: 'sale_collection' as const,
      amount: settlement.byMethod[m],
      method: m,
      // A manually entered mobile-money payment is only "recorded", never provider-verified.
      verification: 'recorded' as const,
      staffId: input.userId,
      deviceId: input.deviceId,
      customerId: input.customer?.id,
      saleId,
      occurredAt: input.nowIso,
    }))

  const customerEntry: CustomerEntryRecord | undefined =
    settlement.outstanding > 0
      ? {
          id: input.newId(),
          tenantId: input.tenantId,
          customerId: input.customer!.id,
          amount: settlement.outstanding,
          kind: 'sale_credit',
          saleId,
          occurredAt: input.nowIso,
        }
      : undefined

  return { sale, lines: lineRecords, movements, transactions, customerEntry, newCostStates, oversoldProductIds: [...oversold] }
}
