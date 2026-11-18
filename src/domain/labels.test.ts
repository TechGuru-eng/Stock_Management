import { describe, expect, it } from 'vitest'
import { SHEETS, barFormat, barsFromBits, clampCopies, expandLabels, labelsPerPage, layoutPages, sheetById, sheetFits } from './labels'

describe('sheet layouts', () => {
  it('every preset fits on its page', () => {
    for (const s of SHEETS) expect(sheetFits(s), s.id).toBe(true)
  })
  it('knows how many labels a sheet holds', () => {
    expect(labelsPerPage(sheetById('a4-21'))).toBe(21)
    expect(labelsPerPage(sheetById('a4-65'))).toBe(65)
    expect(labelsPerPage(sheetById('roll-50x30'))).toBe(1)
    expect(sheetById('nonsense').id).toBe('a4-21')
  })
  it('fills left to right, then down, then onto a new page', () => {
    const sheet = sheetById('a4-24') // 3 x 8
    const pages = layoutPages(sheet, 26)
    expect(pages).toHaveLength(2)
    expect(pages[0]).toHaveLength(24)
    expect(pages[1]).toHaveLength(2)
    expect(pages[0][0]).toMatchObject({ x: 0, y: 0.5, index: 0 })
    expect(pages[0][1].x).toBe(70)
    expect(pages[0][3]).toMatchObject({ x: 0, y: 37.5 }) // second row
    expect(pages[1][0].index).toBe(24)
  })
  it('a partly used sheet can be started at a later cell', () => {
    const pages = layoutPages(sheetById('a4-24'), 3, 22) // only cells 22 and 23 are left on page 1
    expect(pages.map((p) => p.length)).toEqual([2, 1])
    expect(pages[0][0]).toMatchObject({ index: 0 })
    expect(pages[0][0].x).toBeCloseTo(70, 5) // column 2 of the last row
    expect(layoutPages(sheetById('a4-24'), 2, 999)[0].length).toBe(1) // a silly start is held to the last cell
  })
  it('a roll prints one label per page', () => {
    expect(layoutPages(sheetById('roll-50x30'), 4)).toHaveLength(4)
  })
  it('nothing to print means no pages', () => {
    expect(layoutPages(sheetById('a4-21'), 0)).toEqual([])
  })
})

describe('what gets printed', () => {
  const products = new Map([
    ['a', { name: 'Eau 1.5L', barcode: '5449000000996', price: 500 }],
    ['b', { name: 'Sans code', price: 100 }],
    ['c', { name: 'Riz', barcode: ' 2000000000008 ', price: null }],
  ])
  it('repeats copies, cleans codes, skips (and reports) products without a code', () => {
    const r = expandLabels([{ productId: 'a', copies: 2 }, { productId: 'b', copies: 3 }, { productId: 'c', copies: 1 }, { productId: 'zzz', copies: 5 }], products, true)
    expect(r.items.map((i) => [i.name, i.code, i.price])).toEqual([['Eau 1.5L', '5449000000996', 500], ['Eau 1.5L', '5449000000996', 500], ['Riz', '2000000000008', null]])
    expect(r.skipped).toEqual(['Sans code'])
  })
  it('leaves the price off when asked', () => {
    expect(expandLabels([{ productId: 'a', copies: 1 }], products, false).items[0].price).toBeNull()
  })
  it('holds copies and the total to sensible limits', () => {
    expect(clampCopies(5000)).toBe(200)
    expect(clampCopies(-3)).toBe(0)
    expect(clampCopies(2.9)).toBe(2)
    expect(clampCopies(NaN)).toBe(0)
    const many = new Map(Array.from({ length: 30 }, (_, i) => [`p${i}`, { name: `P${i}`, barcode: '5449000000996', price: 1 }]))
    const r = expandLabels([...many.keys()].map((k) => ({ productId: k, copies: 200 })), many, true)
    expect(r.items).toHaveLength(2000)
    expect(r.truncated).toBe(true)
  })
})

describe('bar patterns', () => {
  it('standard codes keep their own pattern; a wrong check digit or other text falls back to Code 128 so it still scans', () => {
    expect(barFormat('5449000000996')).toBe('EAN13')
    expect(barFormat('96385074')).toBe('EAN8')
    expect(barFormat('036000291452')).toBe('UPC')
    expect(barFormat('5449000000997')).toBe('CODE128')
    expect(barFormat('AB-12')).toBe('CODE128')
    expect(barFormat('12345')).toBe('CODE128')
  })
  it('turns bits into joined black bars', () => {
    expect(barsFromBits('0110100111')).toEqual({ bars: [{ at: 1, width: 2 }, { at: 4, width: 1 }, { at: 7, width: 3 }], modules: 10 })
    expect(barsFromBits('0000')).toEqual({ bars: [], modules: 4 })
  })
})
