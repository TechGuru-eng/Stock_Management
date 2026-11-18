import { db, newId, type ProductRec, type UnitRec } from './db'
import { cleanBarcode, findByBarcode } from '../domain/barcode'
import { can } from '../domain/permissions'
import {
  diffFields, validateNewUnit, validateProductPatch, validateUnitPatch,
  type EditProblem, type ProductPatch, type UnitPatch,
} from '../domain/productEdit'
import { queue, type Ctx } from './repo'

export class EditError extends Error {
  problems: EditProblem[]
  constructor(message: string, problems: EditProblem[] = []) {
    super(message)
    this.name = 'EditError'
    this.problems = problems
  }
}

function allowed(ctx: Ctx) {
  if (!can(ctx.role, 'products.write')) throw new EditError('not allowed to edit products')
}

/**
 * Change a product's details. Only fields that really differ are saved (and uploaded, with the old values, so the change log can
 * show what it used to be). Returns false when nothing changed. Barcode and sku must stay unique; a barcode can be cleared.
 */
export async function updateProduct(ctx: Ctx, productId: string, patch: ProductPatch): Promise<boolean> {
  allowed(ctx)
  // only these fields can ever be changed here (never the base unit, or whether it is a service)
  const clean: ProductPatch = { name: patch.name, barcode: patch.barcode, sku: patch.sku, minStock: patch.minStock, taxRateBp: patch.taxRateBp, active: patch.active, trackExpiry: patch.trackExpiry }
  if (clean.name !== undefined) clean.name = clean.name.trim()
  if (clean.barcode !== undefined) clean.barcode = clean.barcode === null ? null : cleanBarcode(clean.barcode) || null
  if (clean.sku !== undefined) clean.sku = clean.sku === null ? null : clean.sku.trim() || null
  const problems = validateProductPatch(clean)
  if (problems.length) throw new EditError(`invalid: ${problems.join(', ')}`, problems)

  return db.transaction('rw', [db.products, db.outbox], async () => {
    const p = await db.products.get(productId)
    if (!p) throw new EditError('product not found')
    const current = { name: p.name, barcode: p.barcode ?? null, sku: p.sku ?? null, minStock: p.minStock, taxRateBp: p.taxRateBp, active: p.active, trackExpiry: Boolean(p.trackExpiry) }
    const { changes, before } = diffFields(current, clean)
    if (Object.keys(changes).length === 0) return false

    const all = await db.products.toArray()
    if (typeof changes.barcode === 'string' && findByBarcode(all.filter((x) => x.id !== productId), changes.barcode)) throw new EditError('a product with this barcode already exists')
    if (typeof changes.sku === 'string' && all.some((x) => x.id !== productId && x.sku === changes.sku)) throw new EditError('a product with this reference already exists')

    const local: Partial<ProductRec> = {
      ...changes,
      barcode: 'barcode' in changes ? (changes.barcode ?? undefined) : p.barcode,
      sku: 'sku' in changes ? (changes.sku ?? undefined) : p.sku,
    } as Partial<ProductRec>
    await db.products.update(productId, local)
    // `id` is the product's id, so a download from the server does not overwrite this change before it has been uploaded
    await queue('product_edit', { id: productId, tenantId: ctx.tenantId, changes, before }, newId())
    return true
  })
}

/** Change a unit's selling price and / or name. The factor (how many base units) is fixed. */
export async function updateUnit(ctx: Ctx, unitId: string, patch: UnitPatch): Promise<boolean> {
  allowed(ctx)
  // only these two fields can ever be changed here, whatever else a caller passes (the factor is fixed)
  const clean: UnitPatch = { name: patch.name?.trim(), sellPrice: patch.sellPrice }
  const problems = validateUnitPatch(clean)
  if (problems.length) throw new EditError(`invalid: ${problems.join(', ')}`, problems)
  return db.transaction('rw', [db.units, db.outbox], async () => {
    const u = await db.units.get(unitId)
    if (!u) throw new EditError('unit not found')
    const { changes, before } = diffFields({ name: u.name, sellPrice: u.sellPrice }, clean)
    if (Object.keys(changes).length === 0) return false
    if (changes.name !== undefined) {
      const siblings = await db.units.where('productId').equals(u.productId).toArray()
      if (siblings.some((x) => x.id !== unitId && x.name.toLowerCase() === changes.name!.toLowerCase())) throw new EditError('this product already has a unit with that name', ['unit_name'])
    }
    await db.units.update(unitId, changes)
    await queue('unit_edit', { id: unitId, tenantId: ctx.tenantId, productId: u.productId, changes, before }, newId())
    return true
  })
}

/** Add a bigger unit (a carton of 24) to an existing product. */
export async function addUnit(ctx: Ctx, productId: string, input: { name: string; factor: number; sellPrice: number }): Promise<UnitRec> {
  allowed(ctx)
  return db.transaction('rw', [db.products, db.units, db.outbox], async () => {
    if (!(await db.products.get(productId))) throw new EditError('product not found')
    const existing = await db.units.where('productId').equals(productId).toArray()
    const problems = validateNewUnit(input.name, input.factor, input.sellPrice, existing)
    if (problems.length) throw new EditError(`invalid: ${problems.join(', ')}`, problems)
    const unit: UnitRec = { id: newId(), tenantId: ctx.tenantId, productId, name: input.name.trim(), factor: input.factor, sellPrice: input.sellPrice, isBase: false }
    await db.units.add(unit)
    await queue('product_units', unit, unit.id)
    return unit
  })
}
