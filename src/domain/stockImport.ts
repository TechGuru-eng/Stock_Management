import { cleanBarcode, sameBarcode } from './barcode'
import { mapHeaders, parseAmount } from './csvParse'
import { percentToBp } from './productEdit'
import { MAX_IMPORT_ROWS, type KnownProduct } from './priceImport'

/**
 * Opening stock from a spreadsheet: how many of each product are on the shelf and what they cost. Same promise as the price import:
 * the file becomes a PLAN that a person reads and confirms; nothing is changed before that.
 *
 * Safety rule: opening stock can only be recorded for a product that has NO stock history in this shop. A second import of the same
 * file (or an import over a shop that already trades) would double the stock, so those rows are refused; the Counts feature is the way
 * to correct stock that already moves.
 */
export type StockProblem =
  | 'no_name_or_code' | 'bad_quantity' | 'bad_cost' | 'cost_required' | 'cost_conflict' | 'unknown_unit' | 'fractional_base' | 'ambiguous_name'
  | 'barcode_mismatch' | 'duplicate_row' | 'already_has_stock' | 'not_found' | 'needs_name_and_price' | 'is_service'

export type StockPlanRow =
  | { line: number; kind: 'opening'; productId: string; name: string; unitId: string; unitName: string; baseQty: number; totalCost: number; flagged: boolean }
  | { line: number; kind: 'create'; name: string; barcode?: string; unitName: string; price: number; baseQty: number; totalCost: number; minStock: number; taxRateBp: number; flagged: boolean }
  | { line: number; kind: 'skip'; name: string }
  | { line: number; kind: 'error'; name: string; problem: StockProblem }

export interface StockPlan {
  rows: StockPlanRow[]
  fatal: 'empty' | 'no_identifier_column' | 'no_quantity_column' | 'no_cost_column' | 'too_many_rows' | null
  counts: { opening: number; create: number; skip: number; error: number; flagged: number }
  /** What the stock to be recorded is worth at cost, in FCFA. */
  totalValue: number
}

const cell = (r: readonly string[], i: number | undefined) => (i === undefined ? '' : (r[i] ?? '').trim())
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

export function planStockImport(rows: readonly (readonly string[])[], products: readonly KnownProduct[], opts: { createMissing: boolean }): StockPlan {
  const none = (fatal: StockPlan['fatal']): StockPlan => ({ rows: [], fatal, counts: { opening: 0, create: 0, skip: 0, error: 0, flagged: 0 }, totalValue: 0 })
  if (rows.length < 2) return none('empty')
  const cols = mapHeaders(rows[0])
  if (cols.name === undefined && cols.barcode === undefined && cols.sku === undefined) return none('no_identifier_column')
  if (cols.quantity === undefined) return none('no_quantity_column')
  if (cols.unitCost === undefined && cols.totalCost === undefined) return none('no_cost_column')
  const data = rows.slice(1)
  if (data.length > MAX_IMPORT_ROWS) return none('too_many_rows')

  const byName = new Map<string, KnownProduct[]>()
  for (const p of products) byName.set(key(p.name), [...(byName.get(key(p.name)) ?? []), p])
  const seen = new Set<string>()
  const out: StockPlanRow[] = []

  data.forEach((r, idx) => {
    const line = idx + 2
    const name = cell(r, cols.name)
    const barcode = cleanBarcode(cell(r, cols.barcode))
    const sku = cell(r, cols.sku)
    const unitName = cell(r, cols.unit)
    const label = name || barcode || sku
    const err = (problem: StockProblem): void => { out.push({ line, kind: 'error', name: label, problem }) }
    if (!name && !barcode && !sku) return err('no_name_or_code')

    const qty = parseAmount(cell(r, cols.quantity))
    if (qty === null) return err('bad_quantity')
    const totalText = cell(r, cols.totalCost)
    const unitText = cell(r, cols.unitCost)
    const totalGiven = totalText === '' ? null : parseAmount(totalText)
    const unitGiven = unitText === '' ? null : parseAmount(unitText)
    if ((totalText !== '' && totalGiven === null) || (unitText !== '' && unitGiven === null)) return err('bad_cost')

    // --- the product: barcode, then reference, then exact name (never guessed)
    let product: KnownProduct | undefined
    if (barcode) product = products.find((p) => p.barcode && sameBarcode(p.barcode, barcode))
    if (!product && sku) product = products.find((p) => p.sku && p.sku === sku)
    if (!product && name) {
      const named = byName.get(key(name)) ?? []
      if (named.length > 1) return err('ambiguous_name')
      product = named[0]
      if (product && barcode && product.barcode) return err('barcode_mismatch')
    }

    // --- cost of this row: a total wins; otherwise unit cost x quantity; both given must agree
    let total: number | null = totalGiven
    if (total === null && unitGiven !== null) total = unitGiven * qty
    if (total !== null && totalGiven !== null && unitGiven !== null && Math.abs(totalGiven - unitGiven * qty) > 1) return err('cost_conflict')

    if (!product) {
      if (!opts.createMissing) return err('not_found')
      const priceText = cell(r, cols.price)
      const price = priceText === '' ? null : parseAmount(priceText)
      if (!name || price === null) return err('needs_name_and_price')
      if (qty > 0 && total === null) return err('cost_required')
      if (seen.has(`new:${key(name)}`)) return err('duplicate_row')
      seen.add(`new:${key(name)}`)
      const minText = cell(r, cols.minStock)
      const taxText = cell(r, cols.taxPercent)
      const cost = total ?? 0
      out.push({
        line, kind: 'create', name, barcode: barcode || undefined, unitName: unitName || 'piece', price, baseQty: qty, totalCost: cost,
        minStock: minText === '' ? 0 : (parseAmount(minText) ?? 0), taxRateBp: taxText === '' ? 0 : (percentToBp(taxText.replace('%', '')) ?? 0),
        flagged: qty > 0 && cost > price * qty,
      })
      return
    }

    if (product.isService) return err('is_service')
    const unit = unitName ? product.units.find((u) => key(u.name) === key(unitName)) : product.units.find((u) => u.isBase)
    if (!unit) return err('unknown_unit')
    const dupKey = product.id
    if (seen.has(dupKey)) return err('duplicate_row')
    seen.add(dupKey)
    if (qty === 0) { out.push({ line, kind: 'skip', name: product.name }); return }
    if (total === null) return err('cost_required')
    if (product.hasStockHistory) return err('already_has_stock')
    const base = qty * unit.factor
    if (!Number.isInteger(base)) return err('fractional_base')
    const base1 = product.units.find((u) => u.isBase)
    // a cost above the selling price of the same quantity is usually columns the wrong way round
    const flagged = Boolean(base1 && total > base1.sellPrice * base)
    out.push({ line, kind: 'opening', productId: product.id, name: product.name, unitId: unit.id, unitName: unit.name, baseQty: base, totalCost: total, flagged })
  })

  const count = (k: StockPlanRow['kind']) => out.filter((x) => x.kind === k).length
  return {
    rows: out, fatal: null,
    counts: { opening: count('opening'), create: count('create'), skip: count('skip'), error: count('error'), flagged: out.filter((x) => (x.kind === 'opening' || x.kind === 'create') && x.flagged).length },
    totalValue: out.reduce((t, x) => t + (x.kind === 'opening' || x.kind === 'create' ? x.totalCost : 0), 0),
  }
}
