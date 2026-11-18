import { db, newId } from './db'
import { queue, type Ctx } from './repo'
import { can } from '../domain/permissions'
import { currentQuotes, quoteKey, type SupplierPriceRecord } from '../domain/supplierPrices'
import type { SupplierPlan } from '../domain/supplierPriceImport'

/**
 * Record what a supplier quotes for one unit of a product. A quote is a new line in an append-only history (the newest wins); asking for the
 * price already current changes nothing. Needs the right to manage purchases.
 */
export async function setSupplierPrice(
  ctx: Ctx,
  input: { supplierId: string; productId: string; unitId: string; price: number; source?: 'manual' | 'import' },
): Promise<SupplierPriceRecord | null> {
  if (!can(ctx.role, 'purchases.manage')) throw new Error('not allowed to manage supplier prices')
  if (!Number.isInteger(input.price) || input.price < 0 || input.price > 1_000_000_000) throw new Error('the price must be a whole number of FCFA')
  return db.transaction('rw', [db.suppliers, db.units, db.supplierPrices, db.outbox], async () => {
    if (!(await db.suppliers.get(input.supplierId))) throw new Error('supplier not found')
    const unit = await db.units.get(input.unitId)
    if (!unit || unit.productId !== input.productId) throw new Error('unit does not belong to this product')
    const existing = currentQuotes(await db.supplierPrices.where('supplierId').equals(input.supplierId).toArray()).get(quoteKey(input))
    if (existing && existing.price === input.price) return null
    const rec: SupplierPriceRecord = {
      id: newId(), tenantId: ctx.tenantId, supplierId: input.supplierId, productId: input.productId, unitId: input.unitId, price: input.price,
      source: input.source ?? 'manual', recordedBy: ctx.userId, recordedAt: new Date().toISOString(),
    }
    await db.supplierPrices.add(rec)
    await queue('supplier_prices', rec, rec.id)
    return rec
  })
}

export interface SupplierImportResult {
  saved: number
  skipped: number
  failed: { line: number; name: string; message: string }[]
}

/** Apply a supplier price list plan the person has confirmed. Big jumps wait for an explicit yes; one bad line never blocks the rest. */
export async function applySupplierImport(ctx: Ctx, supplierId: string, plan: SupplierPlan, opts: { includeFlagged: boolean }): Promise<SupplierImportResult> {
  if (!can(ctx.role, 'purchases.manage')) throw new Error('not allowed to manage supplier prices')
  const res: SupplierImportResult = { saved: 0, skipped: 0, failed: [] }
  for (const row of plan.rows) {
    if (row.kind !== 'set') continue
    if (row.flagged && !opts.includeFlagged) { res.skipped++; continue }
    try {
      if (await setSupplierPrice(ctx, { supplierId, productId: row.productId, unitId: row.unitId, price: row.newPrice, source: 'import' })) res.saved++
    } catch (e) {
      res.failed.push({ line: row.line, name: row.name, message: (e as Error).message })
    }
  }
  return res
}
