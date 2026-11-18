import { describe, expect, it } from 'vitest'
import { parseCsv } from './csvParse'
import type { KnownProduct } from './priceImport'
import { planSupplierImport } from './supplierPriceImport'

const water: KnownProduct = {
  id: 'p1', name: 'Eau 1.5L', barcode: '5449000000996', minStock: 0, taxRateBp: 0, active: true, baseUnit: 'bouteille', isService: false,
  units: [{ id: 'u1', name: 'bouteille', factor: 1, sellPrice: 500, isBase: true }, { id: 'u2', name: 'carton', factor: 24, sellPrice: 11000, isBase: false }],
}
const rice: KnownProduct = { id: 'p2', name: 'Riz', minStock: 0, taxRateBp: 0, active: true, baseUnit: 'kg', isService: false, units: [{ id: 'u3', name: 'kg', factor: 1, sellPrice: 800, isBase: true }] }
const current = new Map([['p1|u2', 7000]])
const plan = (csv: string) => planSupplierImport(parseCsv(csv), [water, rice], (p, u) => current.get(`${p}|${u}`) ?? null)

describe('a supplier price list file', () => {
  it('new quotes and changed quotes, with the change in percent', () => {
    const p = plan('Désignation;Unité;Prix d\'achat\nEau 1.5L;carton;7 350\nEau 1.5L;bouteille;290\nRiz;;600')
    expect(p.rows).toMatchObject([
      { kind: 'set', productId: 'p1', unitId: 'u2', oldPrice: 7000, newPrice: 7350, changeBp: 500, flagged: false },
      { kind: 'set', unitId: 'u1', oldPrice: null, newPrice: 290, changeBp: null },
      { kind: 'set', productId: 'p2', unitId: 'u3', oldPrice: null, newPrice: 600 },
    ])
    expect(p.counts).toMatchObject({ set: 3, newQuotes: 2, changed: 1 })
  })
  it('accepts "price" or "cost" as the column, matches by barcode, and ignores unchanged quotes', () => {
    const p = plan('barcode;unit;cost\n5449000000996;carton;7000')
    expect(p.rows[0]).toMatchObject({ kind: 'unchanged' })
    expect(plan('barcode;price\n5449000000996;260').rows[0]).toMatchObject({ kind: 'set', productId: 'p1' })
  })
  it('a quote that jumps by more than 30% is highlighted', () => {
    expect(plan('name;unit;price\nEau 1.5L;carton;10 000').rows[0]).toMatchObject({ flagged: true, changeBp: 4286 })
    expect(plan('name;unit;price\nEau 1.5L;carton;4 000').rows[0]).toMatchObject({ flagged: true })
  })
  it('mistakes are reported per line, never guessed', () => {
    const p = plan('name;unit;price\nEau 1.5L;palette;100\nInconnu;;100\n;;100\nRiz;;abc\nRiz;;\nRiz;;600\nRiz;;650')
    expect(p.rows.map((r) => (r.kind === 'error' ? r.problem : r.kind))).toEqual(['unknown_unit', 'not_found', 'no_name_or_code', 'bad_price', 'price_missing', 'set', 'duplicate_row'])
  })
  it('whole-file problems', () => {
    expect(plan('').fatal).toBe('empty')
    expect(plan('price\n5').fatal).toBe('no_identifier_column')
    expect(plan('name\nEau').fatal).toBe('no_price_column')
  })
})
