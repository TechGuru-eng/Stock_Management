import { db } from './db'
import { addProduct, postOpeningStock, type Ctx } from './repo'
import { updateProduct, updateUnit } from './productsRepo'
import { toCsv, type Column } from '../domain/csv'
import { can } from '../domain/permissions'
import { bpToPercent } from '../domain/productEdit'
import type { ImportPlan, KnownProduct, PlanRow } from '../domain/priceImport'
import type { StockPlan } from '../domain/stockImport'

/** The catalogue as the importer needs to see it. */
export async function loadKnownProducts(shopId?: string): Promise<KnownProduct[]> {
  const [products, units] = await Promise.all([db.products.toArray(), db.units.toArray()])
  const moved = shopId ? new Set((await db.movements.where('shopId').equals(shopId).toArray()).map((m) => m.productId)) : new Set<string>()
  return products.map((p) => ({
    hasStockHistory: moved.has(p.id),
    id: p.id, name: p.name, barcode: p.barcode, sku: p.sku, minStock: p.minStock, taxRateBp: p.taxRateBp, active: p.active, baseUnit: p.baseUnit, isService: p.isService,
    units: units.filter((u) => u.productId === p.id).map((u) => ({ id: u.id, name: u.name, factor: u.factor, sellPrice: u.sellPrice, isBase: u.isBase })),
  }))
}

export interface ApplyResult {
  updated: number
  created: number
  skipped: number
  failed: { line: number; name: string; message: string }[]
}

/**
 * Apply a plan that a person has read and confirmed. Every row is applied on its own (each is saved and uploaded like a normal edit,
 * with the same checks), so one bad row never blocks the others; failures are listed with their line. Flagged rows (a price that moved by
 * more than half) are skipped unless the person ticked them.
 */
export async function applyImport(ctx: Ctx, plan: ImportPlan, opts: { includeFlagged: boolean }): Promise<ApplyResult> {
  if (!can(ctx.role, 'products.write')) throw new Error('not allowed to edit products')
  const res: ApplyResult = { updated: 0, created: 0, skipped: 0, failed: [] }
  for (const row of plan.rows) {
    if (row.kind === 'unchanged' || row.kind === 'error') continue
    if (row.kind === 'update' && row.flagged && !opts.includeFlagged) { res.skipped++; continue }
    try {
      if (row.kind === 'update') {
        const price = row.changes.find((c) => c.field === 'price')
        if (price && row.unitId) await updateUnit(ctx, row.unitId, { sellPrice: price.to as number })
        const patch: Parameters<typeof updateProduct>[2] = {}
        for (const c of row.changes) {
          if (c.field === 'minStock') patch.minStock = c.to as number
          if (c.field === 'taxRateBp') patch.taxRateBp = c.to as number
          if (c.field === 'barcode') patch.barcode = c.to as string
        }
        if (Object.keys(patch).length) await updateProduct(ctx, row.productId, patch)
        res.updated++
      } else {
        await addProduct(ctx, {
          name: row.name, barcode: row.barcode, baseUnit: row.unitName, minStock: row.minStock, taxRateBp: row.taxRateBp, isService: false,
          units: [{ name: row.unitName, factor: 1, sellPrice: row.price, isBase: true }], openingQty: 0, openingTotalCost: 0,
        })
        res.created++
      }
    } catch (e) {
      res.failed.push({ line: row.line, name: (row as Extract<PlanRow, { name: string }>).name, message: (e as Error).message })
    }
  }
  return res
}

interface CatalogueRow { name: string; barcode: string; sku: string; unit: string; price: number; minStock: number | null; tax: string | null }

/** The whole catalogue as a CSV one can edit in a spreadsheet and import back: one line per unit of each product. */
export async function exportCatalogueCsv(sep: ';' | ','): Promise<string> {
  const products = (await db.products.orderBy('name').toArray()).filter((p) => p.active)
  const units = await db.units.toArray()
  const rows: CatalogueRow[] = []
  for (const p of products) {
    for (const u of units.filter((x) => x.productId === p.id).sort((a, b) => a.factor - b.factor)) {
      rows.push({
        name: p.name, barcode: p.barcode ?? '', sku: p.sku ?? '', unit: u.name, price: u.sellPrice,
        minStock: u.isBase ? p.minStock : null, tax: u.isBase ? bpToPercent(p.taxRateBp) : null,
      })
    }
  }
  const cols: Column<CatalogueRow>[] = [
    { label: 'name', value: (r) => r.name }, { label: 'barcode', value: (r) => r.barcode }, { label: 'sku', value: (r) => r.sku }, { label: 'unit', value: (r) => r.unit },
    { label: 'price', value: (r) => r.price }, { label: 'min_stock', value: (r) => r.minStock }, { label: 'tax_percent', value: (r) => r.tax },
  ]
  return toCsv(cols, rows, sep)
}

export interface StockApplyResult {
  recorded: number
  created: number
  skipped: number
  failed: { line: number; name: string; message: string }[]
  value: number
}

/**
 * Apply an opening stock plan the person has read and confirmed. Each row is recorded on its own (new products with their stock, existing
 * products with an opening movement), so one bad row never blocks the others. A product that gained stock history since the plan was made
 * is refused at this point (nothing is ever doubled). Rows flagged as "cost above price" are skipped unless included.
 */
export async function applyStockImport(ctx: Ctx, plan: StockPlan, opts: { includeFlagged: boolean }): Promise<StockApplyResult> {
  if (!can(ctx.role, 'stock.receive') || !can(ctx.role, 'products.write')) throw new Error('not allowed to import stock')
  const res: StockApplyResult = { recorded: 0, created: 0, skipped: 0, failed: [], value: 0 }
  for (const row of plan.rows) {
    if (row.kind === 'skip' || row.kind === 'error') continue
    if (row.flagged && !opts.includeFlagged) { res.skipped++; continue }
    try {
      if (row.kind === 'opening') {
        await postOpeningStock(ctx, row.productId, row.baseQty, row.totalCost)
        res.recorded++
      } else {
        await addProduct(ctx, {
          name: row.name, barcode: row.barcode, baseUnit: row.unitName, minStock: row.minStock, taxRateBp: row.taxRateBp, isService: false,
          units: [{ name: row.unitName, factor: 1, sellPrice: row.price, isBase: true }], openingQty: row.baseQty, openingTotalCost: row.totalCost,
        })
        res.created++
      }
      res.value += row.totalCost
    } catch (e) {
      res.failed.push({ line: row.line, name: row.name, message: (e as Error).message })
    }
  }
  return res
}
