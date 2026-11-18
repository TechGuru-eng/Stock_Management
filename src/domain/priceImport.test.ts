import { describe, expect, it } from 'vitest'
import { parseCsv } from './csvParse'
import { planImport, type KnownProduct } from './priceImport'

const water: KnownProduct = {
  id: 'p1', name: 'Eau 1.5L', barcode: '5449000000996', minStock: 6, taxRateBp: 0, active: true, baseUnit: 'bouteille', isService: false,
  units: [{ id: 'u1', name: 'bouteille', factor: 1, sellPrice: 500, isBase: true }, { id: 'u2', name: 'carton', factor: 24, sellPrice: 11000, isBase: false }],
}
const rice: KnownProduct = { id: 'p2', name: 'Riz', minStock: 0, taxRateBp: 1925, active: true, baseUnit: 'kg', isService: false, units: [{ id: 'u3', name: 'kg', factor: 1, sellPrice: 800, isBase: true }] }
const rice2: KnownProduct = { ...rice, id: 'p3', units: [{ id: 'u4', name: 'kg', factor: 1, sellPrice: 900, isBase: true }] }
const known = [water, rice]
const plan = (csv: string, createMissing = false, products = known) => planImport(parseCsv(csv), products, { createMissing })

describe('matching rows to products', () => {
  it('finds a product by barcode first, then reference, then exact name', () => {
    const p = plan('barcode;name;price\n5449000000996;n importe quoi;600\n;riz ;850')
    expect(p.rows.map((r) => r.kind === 'update' ? [r.productId, r.changes[0].to] : r.kind)).toEqual([['p1', 600], ['p2', 850]])
  })
  it('a UPC-A spelling of a stored EAN-13 still matches', () => {
    const p = plan('barcode;price\n036000291452;100', false, [{ ...water, barcode: '0036000291452' }])
    expect(p.rows[0].kind).toBe('update')
  })
  it('never guesses: two products with the same name, or the same name with a different barcode, are errors', () => {
    expect(plan('name;price\nRiz;1000', false, [rice, rice2]).rows[0]).toMatchObject({ kind: 'error', problem: 'ambiguous_name' })
    expect(plan('name;barcode;price\nEau 1.5L;1111111111116;600').rows[0]).toMatchObject({ kind: 'error', problem: 'barcode_mismatch' })
  })
})

describe('what changes', () => {
  it('reports price changes with the old and new price, per unit', () => {
    const p = plan('nom;unité;prix\nEau 1.5L;bouteille;550\nEau 1.5L;carton;12 000')
    expect(p.rows).toMatchObject([
      { kind: 'update', unitId: 'u1', changes: [{ field: 'price', from: 500, to: 550 }] },
      { kind: 'update', unitId: 'u2', changes: [{ field: 'price', from: 11000, to: 12000 }] },
    ])
  })
  it('a row that changes nothing is "unchanged"; a blank unit means the base unit', () => {
    const p = plan('name;price\nEau 1.5L;500\nRiz;800')
    expect(p.counts).toMatchObject({ unchanged: 2, update: 0 })
  })
  it('also updates minimum stock and tax, and gives a barcode to a product that has none', () => {
    const p = plan('name;barcode;price;min_stock;tax\nRiz;2000000000008;800;10;19,25')
    expect(p.rows[0]).toMatchObject({ kind: 'update', changes: [{ field: 'minStock', from: 0, to: 10 }, { field: 'barcode', from: null, to: '2000000000008' }] })
    expect(plan('name;barcode;price;min_stock;tax\nRiz;2000000000008;800;10;5').rows[0]).toMatchObject({ changes: expect.arrayContaining([{ field: 'taxRateBp', from: 1925, to: 500 }]) })
  })
  it('the barcode decides which product a row is about, whatever name the spreadsheet uses', () => {
    expect(plan('name;barcode;price\nNom different;5449000000996;800').rows[0]).toMatchObject({ kind: 'update', productId: 'p1' })
  })
  it('highlights a price that jumps by more than half (usually an extra zero)', () => {
    const p = plan('name;price\nEau 1.5L;5000\nRiz;900')
    expect(p.rows.map((r) => r.kind === 'update' && r.flagged)).toEqual([true, false])
    expect(p.counts.flagged).toBe(1)
  })
})

describe('mistakes in the file are reported per line, not guessed', () => {
  it('bad numbers, unknown units, empty rows, duplicates, unknown products', () => {
    const p = plan('name;unit;price\nEau 1.5L;;12.5\nEau 1.5L;palette;100\n;;100\nRiz;;900\nRiz;;950\nInconnu;;100')
    expect(p.rows.map((r) => [r.line, r.kind === 'error' ? r.problem : r.kind])).toEqual([
      [2, 'bad_price'], [3, 'unknown_unit'], [4, 'no_name_or_code'], [5, 'update'], [6, 'duplicate_row'], [7, 'not_found'],
    ])
  })
  it('whole-file problems: empty, no product column, no price column, too many rows', () => {
    expect(plan('').fatal).toBe('empty')
    expect(plan('price\n100').fatal).toBe('no_identifier_column')
    expect(plan('name\nEau').fatal).toBe('no_price_column')
    const many = 'name;price\n' + Array.from({ length: 2001 }, (_, i) => `P${i};1`).join('\n')
    expect(plan(many).fatal).toBe('too_many_rows')
  })
})

describe('adding products that are not found', () => {
  it('only when asked, and only with a name and a price', () => {
    const csv = 'name;barcode;unit;price\nNouveau;3017620422003;boîte;1 200\nSans prix;;;\nNouveau;;;100'
    const off = plan(csv, false)
    expect(off.rows.every((r) => r.kind === 'error')).toBe(true)
    const on = plan(csv, true)
    expect(on.rows[0]).toMatchObject({ kind: 'create', name: 'Nouveau', barcode: '3017620422003', unitName: 'boîte', price: 1200, minStock: 0 })
    expect(on.rows[1]).toMatchObject({ kind: 'error', problem: 'needs_name_and_price' })
    expect(on.rows[2]).toMatchObject({ kind: 'error', problem: 'duplicate_row' })
  })
})

describe('a typical French Excel export', () => {
  it('reads accents, quoted names and spaced prices', () => {
    const csv = '﻿Désignation;Code-barres;Prix de vente\r\n"Huile 1L; tournesol";;1 800\r\nEau 1.5L;5449000000996;"550 FCFA"\r\n'
    const p = plan(csv, true)
    expect(p.rows).toMatchObject([{ kind: 'create', name: 'Huile 1L; tournesol', price: 1800 }, { kind: 'update', changes: [{ field: 'price', to: 550 }] }])
  })
})
