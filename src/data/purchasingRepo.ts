import { db, deviceId, newId, type MovementRec } from './db'
import { recordBatchInTx } from './batchesRepo'
import { loadCost, nextRef, queue, saveCost, type Ctx } from './repo'
import { issue, receive } from '../domain/costing'
import { PaymentError } from '../domain/payments'
import { can } from '../domain/permissions'
import { toBaseQuantity } from '../domain/units'
import {
  buildPurchase, buildReceipt, buildSupplierPayment, buildSupplierReturn, supplierBalance,
  type SupplierRecord,
} from '../domain/purchasing'

function actor(ctx: Ctx) {
  return { newId, tenantId: ctx.tenantId, shopId: ctx.shopId, userId: ctx.userId, deviceId: deviceId(), nowIso: new Date().toISOString() }
}
function need(ctx: Ctx, permission: string) {
  if (!can(ctx.role, permission)) throw new PaymentError('you do not have permission for this action')
}

const TABLES = [
  db.suppliers, db.purchases, db.purchaseLines, db.receipts, db.receiptLines, db.supplierEntries, db.movements, db.costs,
  db.transactions, db.meta, db.outbox, db.products, db.units, db.stockBatches,
]

export async function addSupplier(ctx: Ctx, name: string, phone?: string, notes?: string): Promise<SupplierRecord> {
  need(ctx, 'purchases.manage')
  if (name.trim().length < 2) throw new PaymentError('supplier name is required')
  const s: SupplierRecord = {
    id: newId(), tenantId: ctx.tenantId, name: name.trim(), phone: phone?.trim() || undefined,
    notes: notes?.trim() || undefined, createdAt: new Date().toISOString(),
  }
  await db.transaction('rw', [db.suppliers, db.outbox], async () => {
    await db.suppliers.add(s)
    await queue('suppliers', s, s.id)
  })
  return s
}

export async function supplierPayable(supplierId: string): Promise<number> {
  return supplierBalance(await db.supplierEntries.where('supplierId').equals(supplierId).toArray())
}

/** An order changes nothing in stock and creates no debt. It only records what was asked for. */
export async function createPurchase(
  ctx: Ctx,
  args: { supplierId: string; invoiceNumber?: string; lines: { productId: string; unitId: string; quantity: number; totalCost: number }[] },
) {
  need(ctx, 'purchases.manage')
  return db.transaction('rw', TABLES, async () => {
    const lines = []
    for (const l of args.lines) {
      const unit = await db.units.get(l.unitId)
      if (!unit || unit.productId !== l.productId) throw new PaymentError('unknown unit for this product')
      lines.push({
        productId: l.productId, totalCost: l.totalCost,
        baseQuantity: toBaseQuantity(l.quantity, { id: unit.id, name: unit.name, factor: unit.factor, price: unit.sellPrice }),
      })
    }
    const r = buildPurchase({ ...actor(ctx), supplierId: args.supplierId, invoiceNumber: args.invoiceNumber, lines })
    await db.purchases.add(r.purchase)
    await db.purchaseLines.bulkAdd(r.lines)
    await queue('purchases', r.purchase, r.purchase.id)
    for (const l of r.lines) await queue('purchase_lines', l, r.purchase.id)
    return r
  })
}

/**
 * Goods arrive (all or part of an order). This is the ONLY step that raises stock and creates the
 * debt to the supplier. Anything paid on the spot is recorded as its own separate payment.
 */
export async function receiveGoods(
  ctx: Ctx,
  purchaseId: string,
  deliveries: { purchaseLineId: string; baseQuantity: number; expiry?: string }[],
  paidNow?: { amount: number; method: 'cash' | 'mtn_momo' | 'orange_money' },
) {
  need(ctx, 'stock.receive')
  if (paidNow && paidNow.amount > 0) need(ctx, 'purchases.manage')
  return db.transaction('rw', TABLES, async () => {
    const purchase = await db.purchases.get(purchaseId)
    if (!purchase) throw new PaymentError('order not found')
    const lines = await db.purchaseLines.where('purchaseId').equals(purchaseId).toArray()
    const receipts = await db.receipts.where('purchaseId').equals(purchaseId).toArray()
    const prior = receipts.length ? await db.receiptLines.where('receiptId').anyOf(receipts.map((r) => r.id)).toArray() : []

    const r = buildReceipt({
      ...actor(ctx), purchase, lines, priorReceiptLines: prior, deliveries,
      paidNow: paidNow && paidNow.amount > 0 ? { ...paidNow, reference: await nextRef(ctx.shopId, 'sp') } : undefined,
    })

    // Stock and weighted-average cost move only now.
    for (const m of r.movements) {
      await saveCost(ctx.shopId, m.productId, receive(await loadCost(ctx.shopId, m.productId), m.quantity, m.totalCost ?? 0))
    }
    const g = r.receipt.id
    if (r.payment) {
      await db.transactions.add(r.payment)
      await queue('financial_transactions', r.payment, g)
    }
    await db.receipts.add(r.receipt)
    await db.receiptLines.bulkAdd(r.lines)
    await db.movements.bulkAdd(r.movements.map((m): MovementRec => ({ ...m, tenantId: ctx.tenantId })))
    await db.supplierEntries.bulkAdd(r.entries)
    await queue('goods_receipts', r.receipt, g)
    for (const l of r.lines) await queue('goods_receipt_lines', l, g)
    for (const m of r.movements) await queue('stock_movements', { ...m, tenantId: ctx.tenantId }, g)
    for (const e of r.entries) await queue('supplier_account_entries', e, g)
    // goods that arrive with a best-before date: one batch per delivered line, in the same upload group
    for (const d of deliveries) {
      if (!d.expiry || d.baseQuantity <= 0) continue
      const line = lines.find((l) => l.id === d.purchaseLineId)
      if (line) await recordBatchInTx(ctx, line.productId, d.baseQuantity, d.expiry, g)
    }
    return r
  })
}

export async function paySupplier(
  ctx: Ctx,
  args: { supplierId: string; amount: number; method: 'cash' | 'mtn_momo' | 'orange_money'; purchaseId?: string },
) {
  need(ctx, 'purchases.manage')
  return db.transaction('rw', TABLES, async () => {
    const r = buildSupplierPayment({
      ...actor(ctx), ...args, reference: await nextRef(ctx.shopId, 'sp'), payable: await supplierPayable(args.supplierId),
    })
    await db.transactions.add(r.transaction)
    await db.supplierEntries.add(r.entry)
    await queue('financial_transactions', r.transaction, r.entry.id)
    await queue('supplier_account_entries', r.entry, r.entry.id)
    return r
  })
}

/** Goods sent back: stock goes out at its weighted-average cost, and the supplier credits what we agree. */
export async function returnToSupplier(
  ctx: Ctx,
  args: { supplierId: string; productId: string; baseQuantity: number; creditValue: number; reason: string },
) {
  need(ctx, 'purchases.manage')
  return db.transaction('rw', TABLES, async () => {
    const state = await loadCost(ctx.shopId, args.productId)
    if (state.quantity < args.baseQuantity) throw new PaymentError('not enough stock to return')
    const out = issue(state, args.baseQuantity)
    const r = buildSupplierReturn({ ...actor(ctx), ...args, removedValue: out.cogs })
    await saveCost(ctx.shopId, args.productId, out.state)
    await db.movements.add({ ...r.movement, tenantId: ctx.tenantId })
    await db.supplierEntries.add(r.entry)
    await queue('stock_movements', { ...r.movement, tenantId: ctx.tenantId }, r.movement.id)
    await queue('supplier_account_entries', r.entry, r.movement.id)
    return r
  })
}
