import { describe, expect, it } from 'vitest'
import { parseCsv } from './csvParse'
import type { KnownProduct } from './priceImport'
import { planStockImport } from './stockImport'

const water: KnownProduct = {
  id: 'p1', name: 'Eau 1.5L', barcode: '5449000000996', minStock: 0, taxRateBp: 0, active: true, baseUnit: 'bouteille', isService: false,
  units: [{ id: 'u1', name: 'bouteille', factor: 1, sellPrice: 500, isBase: true }, { id: 'u2', name: 'carton', factor: 24, sellPrice: 11000, isBase: false }],
}
const rice: KnownProduct = { id: 'p2', name: 'Riz', minStock: 0, taxRateBp: 0, active: true, baseUnit: 'kg', isService: false, units: [{ id: 'u3', name: 'kg', factor: 1, sellPrice: 800, isBase: true }] }
const used: KnownProduct = { ...rice, id: 'p3', name: 'Déjà vendu', hasStockHistory: true }
const service: KnownProduct = { ...rice, id: 'p4', name: 'Livraison', isService: true }
const known = [water, rice, used, service]
const plan = (csv: string, createMissing = false) => planStockImport(parseCsv(csv), known, { createMissing })

describe('reading quantities and costs', () => {
  it('quantity in the base unit with a unit cost or a total cost', () => {
    const p = plan('nom;quantité;coût unitaire\nEau 1.5L;48;300\nRiz;10;600')
    expect(p.rows).toMatchObject([
      { kind: 'opening', productId: 'p1', baseQty: 48, totalCost: 14400 },
      { kind: 'opening', productId: 'p2', baseQty: 10, totalCost: 6000 },
    ])
    expect(p.totalValue).toBe(20400)
    expect(plan('nom;quantité;coût total\nEau 1.5L;48;14 400').rows[0]).toMatchObject({ totalCost: 14400 })
  })
  it('a quantity in cartons becomes base units, and a unit cost is per carton then', () => {
    const p = plan('name;unit;qty;unit_cost\nEau 1.5L;carton;3;7 200')
    expect(p.rows[0]).toMatchObject({ kind: 'opening', unitName: 'carton', baseQty: 72, totalCost: 21600 })
  })
  it('a total wins over a unit cost, but they must agree', () => {
    expect(plan('name;qty;unit_cost;total_cost\nRiz;10;600;6000').rows[0]).toMatchObject({ kind: 'opening', totalCost: 6000 })
    expect(plan('name;qty;unit_cost;total_cost\nRiz;10;600;9000').rows[0]).toMatchObject({ kind: 'error', problem: 'cost_conflict' })
  })
  it('matches by barcode, including UPC-A / EAN-13 spellings', () => {
    expect(plan('barcode;qty;total_cost\n5449000000996;5;1500').rows[0]).toMatchObject({ kind: 'opening', productId: 'p1' })
  })
})

describe('what is refused (and why)', () => {
  it('stock that already moves (a second import, or a trading shop) is never doubled', () => {
    expect(plan('name;qty;total_cost\nDéjà vendu;5;100').rows[0]).toMatchObject({ kind: 'error', problem: 'already_has_stock' })
  })
  it('services, fractions of a base unit, missing costs, bad numbers, unknown products and units', () => {
    const p = plan('name;unit;qty;total_cost\nLivraison;;5;100\nRiz;;2.5;100\nRiz;;3;\nRiz;;abc;100\nInconnu;;1;100\nEau 1.5L;palette;1;100')
    expect(p.rows.map((r) => (r.kind === 'error' ? r.problem : r.kind))).toEqual(['is_service', 'bad_quantity', 'cost_required', 'bad_quantity', 'not_found', 'unknown_unit'])
  })
  it('the same product twice in the file counts once', () => {
    expect(plan('name;qty;total_cost\nRiz;5;100\nRiz;6;200').rows.map((r) => r.kind)).toEqual(['opening', 'error'])
  })
  it('quantity zero is skipped quietly', () => {
    expect(plan('name;qty;total_cost\nRiz;0;0').rows[0]).toMatchObject({ kind: 'skip' })
  })
  it('whole-file problems', () => {
    expect(plan('').fatal).toBe('empty')
    expect(plan('qty;total_cost\n1;1').fatal).toBe('no_identifier_column')
    expect(plan('name;total_cost\nRiz;1').fatal).toBe('no_quantity_column')
    expect(plan('name;qty\nRiz;1').fatal).toBe('no_cost_column')
  })
})

describe('a cost above the selling price is flagged (usually columns the wrong way round)', () => {
  it('flags it but still lists it', () => {
    const p = plan('name;qty;unit_cost\nEau 1.5L;10;900\nRiz;10;600')
    expect(p.rows.map((r) => r.kind === 'opening' && r.flagged)).toEqual([true, false])
    expect(p.counts.flagged).toBe(1)
  })
})

describe('adding products that do not exist yet', () => {
  it('only when asked, with a selling price, and the stock goes in with them', () => {
    const csv = 'name;unit;price;qty;unit_cost;barcode\nHuile 1L;litre;1 800;12;1 200;3017620422003\nSans prix;;;5;100;\nSans coût;;900;5;;'
    expect(plan(csv, false).rows.every((r) => r.kind === 'error')).toBe(true)
    const on = plan(csv, true)
    expect(on.rows[0]).toMatchObject({ kind: 'create', name: 'Huile 1L', unitName: 'litre', price: 1800, baseQty: 12, totalCost: 14400, barcode: '3017620422003', flagged: false })
    expect(on.rows[1]).toMatchObject({ kind: 'error', problem: 'needs_name_and_price' })
    expect(on.rows[2]).toMatchObject({ kind: 'error', problem: 'cost_required' })
    expect(on.totalValue).toBe(14400)
  })
})
