import { cleanBarcode, sameBarcode } from './barcode'
import { mapHeaders, parseAmount } from './csvParse'
import { changeBp } from './supplierPrices'
import { MAX_IMPORT_ROWS, type KnownProduct } from './priceImport'

/**
 * A supplier's price list from a spreadsheet: what THEY charge us per product and unit. Becomes a plan the person confirms.
 * Same matching rules as the other imports (barcode, then reference, then exact name; never guessed).
 */
export type SupplierRowProblem =
  | 'no_name_or_code' | 'bad_price' | 'price_missing' | 'unknown_unit' | 'ambiguous_name' | 'barcode_mismatch' | 'duplicate_row' | 'not_found'

export type SupplierPlanRow =
  | { line: number; kind: 'set'; productId: string; unitId: string; name: string; unitName: string; oldPrice: number | null; newPrice: number; changeBp: number | null; flagged: boolean }
  | { line: number; kind: 'unchanged'; name: string }
  | { line: number; kind: 'error'; name: string; problem: SupplierRowProblem }

export interface SupplierPlan {
  rows: SupplierPlanRow[]
  fatal: 'empty' | 'no_identifier_column' | 'no_price_column' | 'too_many_rows' | null
  counts: { set: number; newQuotes: number; changed: number; unchanged: number; error: number; flagged: number }
}

/** A quote that moves by more than this (basis points) is highlighted: usually a typo or a real price hike worth a second look. */
export const BIG_QUOTE_CHANGE_BP = 3000

const cell = (r: readonly string[], i: number | undefined) => (i === undefined ? '' : (r[i] ?? '').trim())
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** `currentPrice(productId, unitId)` is what this supplier currently quotes, or null if nothing yet. */
export function planSupplierImport(
  rows: readonly (readonly string[])[],
  products: readonly KnownProduct[],
  currentPrice: (productId: string, unitId: string) => number | null,
): SupplierPlan {
  const none = (fatal: SupplierPlan['fatal']): SupplierPlan => ({ rows: [], fatal, counts: { set: 0, newQuotes: 0, changed: 0, unchanged: 0, error: 0, flagged: 0 } })
  if (rows.length < 2) return none('empty')
  const cols = mapHeaders(rows[0])
  const priceCol = cols.unitCost ?? cols.price
  if (cols.name === undefined && cols.barcode === undefined && cols.sku === undefined) return none('no_identifier_column')
  if (priceCol === undefined) return none('no_price_column')
  const data = rows.slice(1)
  if (data.length > MAX_IMPORT_ROWS) return none('too_many_rows')

  const byName = new Map<string, KnownProduct[]>()
  for (const p of products) byName.set(key(p.name), [...(byName.get(key(p.name)) ?? []), p])
  const seen = new Set<string>()
  const out: SupplierPlanRow[] = []

  data.forEach((r, idx) => {
    const line = idx + 2
    const name = cell(r, cols.name)
    const barcode = cleanBarcode(cell(r, cols.barcode))
    const sku = cell(r, cols.sku)
    const unitName = cell(r, cols.unit)
    const label = name || barcode || sku
    const err = (problem: SupplierRowProblem): void => { out.push({ line, kind: 'error', name: label, problem }) }
    if (!name && !barcode && !sku) return err('no_name_or_code')

    const priceText = cell(r, priceCol)
    if (priceText === '') return err('price_missing')
    const price = parseAmount(priceText)
    if (price === null) return err('bad_price')

    let product: KnownProduct | undefined
    if (barcode) product = products.find((p) => p.barcode && sameBarcode(p.barcode, barcode))
    if (!product && sku) product = products.find((p) => p.sku && p.sku === sku)
    if (!product && name) {
      const named = byName.get(key(name)) ?? []
      if (named.length > 1) return err('ambiguous_name')
      product = named[0]
      if (product && barcode && product.barcode) return err('barcode_mismatch')
    }
    if (!product) return err('not_found')
    const unit = unitName ? product.units.find((u) => key(u.name) === key(unitName)) : product.units.find((u) => u.isBase)
    if (!unit) return err('unknown_unit')
    const dup = `${product.id}|${unit.id}`
    if (seen.has(dup)) return err('duplicate_row')
    seen.add(dup)

    const old = currentPrice(product.id, unit.id)
    if (old === price) { out.push({ line, kind: 'unchanged', name: product.name }); return }
    const change = changeBp(old, price)
    out.push({
      line, kind: 'set', productId: product.id, unitId: unit.id, name: product.name, unitName: unit.name, oldPrice: old, newPrice: price,
      changeBp: change, flagged: change !== null && Math.abs(change) > BIG_QUOTE_CHANGE_BP,
    })
  })

  const sets = out.filter((x): x is Extract<SupplierPlanRow, { kind: 'set' }> => x.kind === 'set')
  return {
    rows: out, fatal: null,
    counts: {
      set: sets.length, newQuotes: sets.filter((x) => x.oldPrice === null).length, changed: sets.filter((x) => x.oldPrice !== null).length,
      unchanged: out.filter((x) => x.kind === 'unchanged').length, error: out.filter((x) => x.kind === 'error').length, flagged: sets.filter((x) => x.flagged).length,
    },
  }
}
