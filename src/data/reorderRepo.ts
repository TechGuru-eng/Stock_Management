import { db } from './db'
import { createPurchase } from './purchasingRepo'
import type { Ctx } from './repo'
import { can } from '../domain/permissions'
import {
  chooseSuppliers, groupBySupplier, onOrder, salesSpeed, suggestReorders,
  type ProductForReorder, type ReorderSettings, type Sourced,
} from '../domain/reorder'
import { lastPaid } from '../domain/supplierPrices'

export interface ReorderView {
  groups: ReturnType<typeof groupBySupplier>
  rows: Sourced[]
  suppliers: Map<string, { name: string; phone?: string }>
}

/** What to order for the current shop, from its own sales, stock and orders. Always worked out fresh from the records. */
export async function loadReorder(ctx: Ctx, settings: ReorderSettings, now = new Date()): Promise<ReorderView> {
  const from = new Date(now.getTime() - settings.windowDays * 86_400_000).toISOString()
  const to = now.toISOString()
  const [products, units, costs, sales, lines, returns, returnLines, purchases, purchaseLines, receipts, receiptLines, prices, suppliers] = await Promise.all([
    db.products.toArray(), db.units.toArray(), db.costs.where('shopId').equals(ctx.shopId).toArray(), db.sales.toArray(), db.saleLines.toArray(),
    db.saleReturns.toArray(), db.returnLines.toArray(), db.purchases.toArray(), db.purchaseLines.toArray(), db.receipts.toArray(), db.receiptLines.toArray(),
    db.supplierPrices.toArray(), db.suppliers.toArray(),
  ])
  const forReorder: ProductForReorder[] = products.map((p) => {
    const mine = units.filter((u) => u.productId === p.id)
    const pack = mine.filter((u) => u.factor >= 2).sort((a, b) => b.factor - a.factor)[0]
    return { id: p.id, name: p.name, minStock: p.minStock, isService: p.isService, active: p.active, packFactor: pack?.factor ?? 1, packName: pack?.name, baseUnit: p.baseUnit }
  })
  const onHand = new Map(costs.map((c) => [c.productId, c.quantity]))
  const speed = salesSpeed({ sales, lines, returns, returnLines, shopId: ctx.shopId, from, to, windowDays: settings.windowDays })
  const incoming = onOrder(ctx.shopId, purchases, purchaseLines, receiptLines)
  const suggestions = suggestReorders(forReorder, onHand, speed, incoming, settings)
  const unitInfo = new Map(units.map((u) => [u.id, { name: u.name, factor: u.factor }]))
  const avg = new Map(costs.filter((c) => c.quantity > 0).map((c) => [c.productId, Math.round(c.value / c.quantity)]))
  const rows = chooseSuppliers(suggestions, prices, unitInfo, lastPaid(purchases, receipts, receiptLines), avg)
  return { groups: groupBySupplier(rows), rows, suppliers: new Map(suppliers.map((s) => [s.id, { name: s.name, phone: s.phone }])) }
}

export interface OrderDraft {
  supplierId: string
  lines: { productId: string; /** base units */ qty: number; totalCost: number }[]
}

/**
 * Turn reviewed suggestions into purchase orders (one per supplier). These are ORDERS only: no stock moves and no debt arises until
 * the goods are received. Each order is created on its own, so a refused one does not block the others.
 */
export async function createOrdersFromSuggestions(ctx: Ctx, drafts: readonly OrderDraft[]): Promise<{ created: string[]; failed: { supplierId: string; message: string }[] }> {
  if (!can(ctx.role, 'purchases.manage')) throw new Error('not allowed to create orders')
  const created: string[] = []
  const failed: { supplierId: string; message: string }[] = []
  for (const d of drafts) {
    try {
      const units = await db.units.toArray()
      const lines = d.lines.filter((l) => l.qty > 0).map((l) => {
        const base = units.find((u) => u.productId === l.productId && u.isBase)
        if (!base) throw new Error('product has no base unit')
        return { productId: l.productId, unitId: base.id, quantity: l.qty, totalCost: Math.max(Math.round(l.totalCost), 0) }
      })
      const r = await createPurchase(ctx, { supplierId: d.supplierId, lines })
      created.push(r.purchase.id)
    } catch (e) {
      failed.push({ supplierId: d.supplierId, message: (e as Error).message })
    }
  }
  return { created, failed }
}
