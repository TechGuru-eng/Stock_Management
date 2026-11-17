import { db, deviceId, newId, type CustomerRec, type MovementRec, type ProductRec, type UnitRec } from './db'
import { emptyCostState, issue, receive, type CostState } from '../domain/costing'
import type { MovementType } from '../domain/inventory'
import { buildSale, type CartLine, type CheckoutResult } from '../domain/pos'
import type { PaymentInput } from '../domain/payments'
import { toBaseQuantity } from '../domain/units'
import type { Role } from '../domain/permissions'
import { PaymentError } from '../domain/payments'

export interface Ctx {
  tenantId: string
  shopId: string
  userId: string
  role: Role
  oversellPolicy: 'allow_and_flag' | 'block'
}

const costKey = (shopId: string, productId: string) => `${shopId}:${productId}`

export function queue(table: string, payload: unknown, groupId: string) {
  return db.outbox.add({
    id: newId(),
    groupId,
    table,
    payload,
    createdAt: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
  })
}

async function loadCost(shopId: string, productId: string): Promise<CostState> {
  const r = await db.costs.get(costKey(shopId, productId))
  return r ? { quantity: r.quantity, value: r.value, lastUnitCost: r.lastUnitCost } : emptyCostState
}

async function saveCost(shopId: string, productId: string, s: CostState) {
  await db.costs.put({ key: costKey(shopId, productId), shopId, productId, ...s })
}

/* ------------------------------- products ------------------------------- */

export interface NewProductInput {
  name: string
  barcode?: string
  sku?: string
  baseUnit: string
  minStock: number
  taxRateBp: number
  isService: boolean
  /** Selling units; exactly one must be the base unit (factor 1). */
  units: { name: string; factor: number; sellPrice: number; isBase: boolean }[]
  /** Opening stock in base units, and the total cost paid for it. */
  openingQty: number
  openingTotalCost: number
}

export async function addProduct(ctx: Ctx, input: NewProductInput): Promise<string> {
  if (input.name.trim().length < 1) throw new Error('product name is required')
  const base = input.units.filter((u) => u.isBase)
  if (base.length !== 1 || base[0].factor !== 1) throw new Error('exactly one base unit with factor 1 is required')
  if (input.units.length === 0) throw new Error('at least one selling unit is required')

  const now = new Date().toISOString()
  const product: ProductRec = {
    id: newId(),
    tenantId: ctx.tenantId,
    name: input.name.trim(),
    barcode: input.barcode?.trim() || undefined,
    sku: input.sku?.trim() || undefined,
    baseUnit: input.baseUnit,
    minStock: input.minStock,
    taxRateBp: input.taxRateBp,
    isService: input.isService,
    active: true,
    createdAt: now,
  }
  const units: UnitRec[] = input.units.map((u) => ({ id: newId(), tenantId: ctx.tenantId, productId: product.id, ...u }))

  await db.transaction('rw', [db.products, db.units, db.movements, db.costs, db.outbox], async () => {
    if (product.barcode) {
      const dup = await db.products.where('barcode').equals(product.barcode).first()
      if (dup) throw new Error('a product with this barcode already exists')
    }
    await db.products.add(product)
    await db.units.bulkAdd(units)
    // One group: product, its units and opening stock upload together.
    await queue('products', product, product.id)
    for (const u of units) await queue('product_units', u, product.id)

    if (!input.isService && input.openingQty > 0) {
      await postReceipt(ctx, product.id, input.openingQty, input.openingTotalCost, 'opening', undefined, product.id)
    }
  })
  return product.id
}

/* -------------------------------- stock --------------------------------- */

async function postReceipt(
  ctx: Ctx,
  productId: string,
  baseQty: number,
  totalCost: number,
  type: Extract<MovementType, 'opening' | 'purchase_receipt' | 'count_adjustment' | 'return_in'>,
  reason?: string,
  groupId?: string,
) {
  const next = receive(await loadCost(ctx.shopId, productId), baseQty, totalCost)
  await saveCost(ctx.shopId, productId, next)
  const m: MovementRec = {
    id: newId(), tenantId: ctx.tenantId, shopId: ctx.shopId, productId, quantity: baseQty, type, reason,
    staffId: ctx.userId, deviceId: deviceId(), createdAt: new Date().toISOString(),
    unitCost: Math.round(totalCost / baseQty),
    totalCost,
  }
  await db.movements.add(m)
  await queue('stock_movements', m, groupId ?? m.id)
}

/** Goods received. Quantity is in the chosen unit and is converted to base units. */
export async function receiveStock(ctx: Ctx, productId: string, unit: UnitRec, quantity: number, totalCost: number) {
  const baseQty = toBaseQuantity(quantity, { id: unit.id, name: unit.name, factor: unit.factor, price: unit.sellPrice })
  await db.transaction('rw', [db.movements, db.costs, db.outbox], () =>
    postReceipt(ctx, productId, baseQty, totalCost, 'purchase_receipt'),
  )
}

export type RemovalType = Extract<MovementType, 'damaged' | 'expired' | 'missing' | 'giveaway' | 'personal_use'>

/** Stock leaving without a sale. A reason is mandatory. */
export async function removeStock(ctx: Ctx, productId: string, baseQty: number, type: RemovalType, reason: string) {
  if (!reason.trim()) throw new Error('a reason is required')
  if (!Number.isInteger(baseQty) || baseQty <= 0) throw new Error('quantity must be a positive whole number')
  await db.transaction('rw', [db.movements, db.costs, db.outbox], async () => {
    const out = issue(await loadCost(ctx.shopId, productId), baseQty)
    await saveCost(ctx.shopId, productId, out.state)
    const m: MovementRec = {
      id: newId(), tenantId: ctx.tenantId, shopId: ctx.shopId, productId, quantity: -baseQty, type, reason: reason.trim(),
      staffId: ctx.userId, deviceId: deviceId(), createdAt: new Date().toISOString(),
      unitCost: Math.round(out.cogs / baseQty),
      totalCost: out.cogs,
    }
    await db.movements.add(m)
    await queue('stock_movements', m, m.id)
  })
}

/* ------------------------------ customers ------------------------------- */

export async function addCustomer(ctx: Ctx, name: string, phone: string | undefined, creditLimit: number): Promise<CustomerRec> {
  if (name.trim().length < 2) throw new Error('customer name is required')
  const c: CustomerRec = {
    id: newId(), tenantId: ctx.tenantId, name: name.trim(), phone: phone?.trim() || undefined,
    creditLimit, createdAt: new Date().toISOString(),
  }
  await db.transaction('rw', [db.customers, db.outbox], async () => {
    await db.customers.add(c)
    await queue('customers', c, c.id)
  })
  return c
}

export async function customerBalance(customerId: string): Promise<number> {
  const entries = await db.customerEntries.where('customerId').equals(customerId).toArray()
  return entries.reduce((t, e) => t + e.amount, 0)
}

/* -------------------------------- sales --------------------------------- */

async function nextSaleNumber(shopId: string): Promise<string> {
  const key = `saleCounter:${shopId}`
  const cur = ((await db.meta.get(key))?.value as number | undefined) ?? 0
  const next = cur + 1
  await db.meta.put({ key, value: next })
  // The device prefix keeps numbers unique across several offline tills.
  const prefix = deviceId().replace(/-/g, '').slice(0, 4).toUpperCase()
  return `${prefix}-${String(next).padStart(4, '0')}`
}

/** Unique, readable references for money entries: device prefix + kind + counter, e.g. 8DC5-RP-0003. */
export async function nextRef(shopId: string, kind: string): Promise<string> {
  const key = `${kind}Counter:${shopId}`
  const next = (((await db.meta.get(key))?.value as number | undefined) ?? 0) + 1
  await db.meta.put({ key, value: next })
  const prefix = deviceId().replace(/-/g, '').slice(0, 4).toUpperCase()
  return `${prefix}-${kind.toUpperCase()}-${String(next).padStart(4, '0')}`
}

export interface CheckoutArgs {
  lines: CartLine[]
  payments: PaymentInput[]
  customerId?: string
}

/**
 * Records a whole sale atomically on the device: sale, lines, stock movements,
 * money collected, customer debt and updated costs all commit together or not at all.
 */
export async function checkout(ctx: Ctx, args: CheckoutArgs): Promise<CheckoutResult> {
  return db.transaction(
    'rw',
    [db.sales, db.saleLines, db.movements, db.transactions, db.customerEntries, db.costs, db.customers, db.meta, db.outbox],
    async () => {
      const costStates: Record<string, CostState> = {}
      for (const l of args.lines) {
        if (!l.isService) costStates[l.productId] = await loadCost(ctx.shopId, l.productId)
      }
      let customer
      if (args.customerId) {
        const c = await db.customers.get(args.customerId)
        if (!c) throw new PaymentError('customer not found')
        customer = { id: c.id, creditLimit: c.creditLimit, balance: await customerBalance(c.id) }
      }

      const result = buildSale({
        newId, tenantId: ctx.tenantId, shopId: ctx.shopId, userId: ctx.userId, deviceId: deviceId(), role: ctx.role,
        saleNumber: await nextSaleNumber(ctx.shopId), nowIso: new Date().toISOString(),
        lines: args.lines, payments: args.payments, customer, costStates, oversellPolicy: ctx.oversellPolicy,
      })

      await db.sales.add(result.sale)
      await db.saleLines.bulkAdd(result.lines)
      await db.movements.bulkAdd(result.movements.map((m) => ({ ...m, tenantId: ctx.tenantId })))
      if (result.transactions.length) await db.transactions.bulkAdd(result.transactions)
      if (result.customerEntry) await db.customerEntries.add(result.customerEntry)
      for (const [productId, state] of Object.entries(result.newCostStates)) await saveCost(ctx.shopId, productId, state)

      // One group: the sale and everything it produced upload together or not at all.
      const g = result.sale.id
      await queue('sales', result.sale, g)
      for (const l of result.lines) await queue('sale_lines', l, g)
      for (const m of result.movements) await queue('stock_movements', { ...m, tenantId: ctx.tenantId }, g)
      for (const t of result.transactions) await queue('financial_transactions', t, g)
      if (result.customerEntry) await queue('customer_account_entries', result.customerEntry, g)
      return result
    },
  )
}
