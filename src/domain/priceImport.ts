import { cleanBarcode, sameBarcode } from './barcode'
import { mapHeaders, parseAmount, type Field } from './csvParse'
import { percentToBp } from './productEdit'

/**
 * Turns a spreadsheet of products and prices into a PLAN: what would change, what would be created, what is wrong. Nothing is
 * changed until a person has read the plan and confirms it. Pure: no database, no screens.
 */

export interface KnownUnit { id: string; name: string; factor: number; sellPrice: number; isBase: boolean }
export interface KnownProduct {
  id: string
  name: string
  barcode?: string
  sku?: string
  minStock: number
  taxRateBp: number
  active: boolean
  baseUnit: string
  isService: boolean
  /** Has this product any stock movement in the current shop? (Used by the opening stock import.) */
  hasStockHistory?: boolean
  units: KnownUnit[]
}

export type RowProblem =
  | 'no_name_or_code' | 'bad_price' | 'unknown_unit' | 'ambiguous_name' | 'barcode_mismatch' | 'duplicate_row'
  | 'bad_min_stock' | 'bad_tax' | 'needs_name_and_price' | 'not_found' | 'service_stock' | 'barcode_in_use'

export interface FieldChange { field: 'price' | 'minStock' | 'taxRateBp' | 'barcode'; from: number | string | null; to: number | string }

export type PlanRow =
  | { line: number; kind: 'update'; productId: string; unitId: string | null; name: string; unitName: string; changes: FieldChange[]; flagged: boolean }
  | { line: number; kind: 'create'; name: string; barcode?: string; unitName: string; price: number; minStock: number; taxRateBp: number }
  | { line: number; kind: 'unchanged'; name: string }
  | { line: number; kind: 'error'; name: string; problem: RowProblem }

export interface ImportOptions {
  /** Add products that are not found (needs a name and a price). Otherwise they are reported as not found. */
  createMissing: boolean
}

export interface ImportPlan {
  rows: PlanRow[]
  /** Header problems: no column that identifies products, or no price column. */
  fatal: 'empty' | 'no_identifier_column' | 'no_price_column' | 'too_many_rows' | null
  counts: { update: number; create: number; unchanged: number; error: number; flagged: number }
}

export const MAX_IMPORT_ROWS = 2000
/** A price moving by more than this share (basis points) is highlighted: it is usually a typo (an extra zero). */
export const BIG_CHANGE_BP = 5000

const cell = (r: readonly string[], i: number | undefined) => (i === undefined ? '' : (r[i] ?? '').trim())
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

export function planImport(rows: readonly (readonly string[])[], products: readonly KnownProduct[], opts: ImportOptions): ImportPlan {
  const empty = (fatal: ImportPlan['fatal']): ImportPlan => ({ rows: [], fatal, counts: { update: 0, create: 0, unchanged: 0, error: 0, flagged: 0 } })
  if (rows.length < 2) return empty('empty')
  const cols = mapHeaders(rows[0])
  if (cols.barcode === undefined && cols.name === undefined && cols.sku === undefined) return empty('no_identifier_column')
  if (cols.price === undefined && cols.minStock === undefined && cols.taxPercent === undefined) return empty('no_price_column')
  const data = rows.slice(1)
  if (data.length > MAX_IMPORT_ROWS) return empty('too_many_rows')

  const byName = new Map<string, KnownProduct[]>()
  for (const p of products) byName.set(key(p.name), [...(byName.get(key(p.name)) ?? []), p])
  const seen = new Set<string>()
  const newBarcodes = new Set<string>()
  const out: PlanRow[] = []

  data.forEach((r, idx) => {
    const line = idx + 2
    const name = cell(r, cols.name)
    const barcodeRaw = cleanBarcode(cell(r, cols.barcode))
    const sku = cell(r, cols.sku)
    const unitName = cell(r, cols.unit)
    const priceText = cell(r, cols.price)
    const label = name || barcodeRaw || sku
    const err = (problem: RowProblem): void => { out.push({ line, kind: 'error', name: label, problem }) }

    if (!name && !barcodeRaw && !sku) return err('no_name_or_code')

    const price = priceText === '' ? null : parseAmount(priceText)
    if (priceText !== '' && price === null) return err('bad_price')
    const minText = cell(r, cols.minStock)
    const minStock = minText === '' ? null : parseAmount(minText)
    if (minText !== '' && minStock === null) return err('bad_min_stock')
    const taxText = cell(r, cols.taxPercent)
    const taxBp = taxText === '' ? null : percentToBp(taxText.replace('%', ''))
    if (taxText !== '' && taxBp === null) return err('bad_tax')

    // --- find the product: barcode first, then reference, then exact name
    let product: KnownProduct | undefined
    if (barcodeRaw) product = products.find((p) => p.barcode && sameBarcode(p.barcode, barcodeRaw))
    if (!product && sku) product = products.find((p) => p.sku && p.sku === sku)
    if (!product && name) {
      const named = byName.get(key(name)) ?? []
      if (named.length > 1) return err('ambiguous_name')
      product = named[0]
      if (product && barcodeRaw && product.barcode) return err('barcode_mismatch') // same name but a different barcode: do not guess
    }

    if (!product) {
      if (!opts.createMissing) return err('not_found')
      if (!name || price === null) return err('needs_name_and_price')
      if (barcodeRaw && newBarcodes.has(barcodeRaw)) return err('duplicate_row')
      if (seen.has(`new:${key(name)}`)) return err('duplicate_row')
      seen.add(`new:${key(name)}`)
      if (barcodeRaw) newBarcodes.add(barcodeRaw)
      out.push({ line, kind: 'create', name, barcode: barcodeRaw || undefined, unitName: unitName || 'piece', price, minStock: minStock ?? 0, taxRateBp: taxBp ?? 0 })
      return
    }

    // --- which unit's price
    let unit: KnownUnit | undefined
    if (price !== null) {
      unit = unitName ? product.units.find((u) => key(u.name) === key(unitName)) : product.units.find((u) => u.isBase)
      if (!unit) return err('unknown_unit')
    }
    const dupKey = `${product.id}|${unit?.id ?? ''}`
    if (seen.has(dupKey)) return err('duplicate_row')
    seen.add(dupKey)

    const changes: FieldChange[] = []
    if (price !== null && unit && price !== unit.sellPrice) changes.push({ field: 'price', from: unit.sellPrice, to: price })
    if (minStock !== null && minStock !== product.minStock) changes.push({ field: 'minStock', from: product.minStock, to: minStock })
    if (taxBp !== null && taxBp !== product.taxRateBp) changes.push({ field: 'taxRateBp', from: product.taxRateBp, to: taxBp })
    if (barcodeRaw && !product.barcode) {
      if (products.some((p) => p.id !== product!.id && p.barcode && sameBarcode(p.barcode, barcodeRaw))) return err('barcode_in_use')
      changes.push({ field: 'barcode', from: null, to: barcodeRaw })
    }
    if (changes.length === 0) {
      out.push({ line, kind: 'unchanged', name: product.name })
      return
    }
    const p = changes.find((c) => c.field === 'price')
    const flagged = Boolean(p && typeof p.from === 'number' && typeof p.to === 'number' && (p.from === 0 ? false : (Math.abs(p.to - p.from) * 10000) / p.from > BIG_CHANGE_BP))
    out.push({ line, kind: 'update', productId: product.id, unitId: unit?.id ?? null, name: product.name, unitName: unit?.name ?? product.baseUnit, changes, flagged })
  })

  const count = (k: PlanRow['kind']) => out.filter((r) => r.kind === k).length
  return {
    rows: out, fatal: null,
    counts: { update: count('update'), create: count('create'), unchanged: count('unchanged'), error: count('error'), flagged: out.filter((r) => r.kind === 'update' && r.flagged).length },
  }
}

export const TEMPLATE_FIELDS: Field[] = ['name', 'barcode', 'sku', 'unit', 'price', 'minStock', 'taxPercent']
