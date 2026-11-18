import { cleanBarcode } from './barcode'

/**
 * What may be changed on a product, and what may not.
 *  Editable: name, barcode, sku, minimum stock, tax rate, hidden / shown, a unit's selling price and name.
 *  Fixed:    the base unit, a unit's factor, whether it is a service. Changing them would change what stock counts mean or
 *            how old movements add up. (A mistake there is fixed by hiding the product and creating a new one.)
 * Past sales keep the price they were sold at, so changing a price only affects sales made from now on.
 */
export interface ProductPatch {
  name?: string
  /** null = remove the barcode. */
  barcode?: string | null
  sku?: string | null
  minStock?: number
  taxRateBp?: number
  active?: boolean
}

export interface UnitPatch {
  name?: string
  sellPrice?: number
}

export type EditProblem =
  | 'name_length' | 'barcode_length' | 'sku_length' | 'min_stock' | 'tax_rate' | 'price' | 'unit_name' | 'factor' | 'nothing_to_change'

export function validateProductPatch(p: ProductPatch): EditProblem[] {
  const out: EditProblem[] = []
  if (p.name !== undefined && (p.name.trim().length < 1 || p.name.trim().length > 120)) out.push('name_length')
  if (typeof p.barcode === 'string' && cleanBarcode(p.barcode).length > 48) out.push('barcode_length')
  if (typeof p.sku === 'string' && p.sku.trim().length > 40) out.push('sku_length')
  if (p.minStock !== undefined && (!Number.isInteger(p.minStock) || p.minStock < 0 || p.minStock > 1_000_000_000)) out.push('min_stock')
  if (p.taxRateBp !== undefined && (!Number.isInteger(p.taxRateBp) || p.taxRateBp < 0 || p.taxRateBp > 10000)) out.push('tax_rate')
  return out
}

export function validateUnitPatch(p: UnitPatch): EditProblem[] {
  const out: EditProblem[] = []
  if (p.name !== undefined && (p.name.trim().length < 1 || p.name.trim().length > 40)) out.push('unit_name')
  if (p.sellPrice !== undefined && (!Number.isInteger(p.sellPrice) || p.sellPrice < 0 || p.sellPrice > 1_000_000_000)) out.push('price')
  return out
}

export function validateNewUnit(name: string, factor: number, price: number, existing: readonly { name: string; factor: number }[]): EditProblem[] {
  const out = validateUnitPatch({ name, sellPrice: price })
  if (!Number.isInteger(factor) || factor < 2 || factor > 100_000) out.push('factor')
  if (existing.some((u) => u.name.trim().toLowerCase() === name.trim().toLowerCase())) out.push('unit_name')
  return out
}

/** Only the fields that really change, with the old values (kept in the change log so an edit can be undone by hand). */
export function diffFields<T extends object>(current: T, patch: Partial<Record<keyof T, unknown>>): { changes: Partial<T>; before: Partial<T> } {
  const changes: Record<string, unknown> = {}
  const before: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const old = (current as Record<string, unknown>)[k] ?? null
    if ((v ?? null) !== old) {
      changes[k] = v
      before[k] = old
    }
  }
  return { changes: changes as Partial<T>, before: before as Partial<T> }
}

/** Percent typed by a person (19.25) to basis points (1925), exactly. */
export function percentToBp(text: string): number | null {
  const t = text.trim().replace(',', '.')
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null
  return Math.round(Number(t) * 100)
}
export const bpToPercent = (bp: number): string => String(bp / 100)
