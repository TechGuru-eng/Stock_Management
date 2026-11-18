import { describe, expect, it } from 'vitest'
import { bpToPercent, diffFields, percentToBp, validateNewUnit, validateProductPatch, validateUnitPatch } from './productEdit'

describe('what a product edit may contain', () => {
  it('accepts normal edits', () => {
    expect(validateProductPatch({ name: 'Eau 1.5L', barcode: '5449000000996', minStock: 6, taxRateBp: 1925, active: false })).toEqual([])
    expect(validateProductPatch({ barcode: null, sku: null })).toEqual([])
  })
  it('refuses blank names, silly numbers and out-of-range tax', () => {
    expect(validateProductPatch({ name: '   ' })).toContain('name_length')
    expect(validateProductPatch({ name: 'x'.repeat(121) })).toContain('name_length')
    expect(validateProductPatch({ minStock: -1 })).toContain('min_stock')
    expect(validateProductPatch({ minStock: 2.5 })).toContain('min_stock')
    expect(validateProductPatch({ taxRateBp: 10001 })).toContain('tax_rate')
    expect(validateProductPatch({ taxRateBp: -1 })).toContain('tax_rate')
    expect(validateProductPatch({ barcode: 'x'.repeat(60) })).toContain('barcode_length')
  })
  it('unit prices are whole non-negative FCFA; unit names are short', () => {
    expect(validateUnitPatch({ sellPrice: 0 })).toEqual([])
    expect(validateUnitPatch({ sellPrice: -5 })).toContain('price')
    expect(validateUnitPatch({ sellPrice: 10.5 })).toContain('price')
    expect(validateUnitPatch({ name: '' })).toContain('unit_name')
  })
  it('a new unit needs a factor of 2 or more and a name not already used', () => {
    const existing = [{ name: 'bouteille', factor: 1 }]
    expect(validateNewUnit('carton', 24, 11000, existing)).toEqual([])
    expect(validateNewUnit('carton', 1, 11000, existing)).toContain('factor')
    expect(validateNewUnit('carton', 2.5, 11000, existing)).toContain('factor')
    expect(validateNewUnit(' Bouteille ', 6, 3000, existing)).toContain('unit_name')
  })
})

describe('only real changes are recorded, with the old values', () => {
  const p = { name: 'Eau', barcode: undefined as string | undefined, minStock: 5, active: true }
  it('skips untouched and identical fields', () => {
    expect(diffFields(p, { name: 'Eau', minStock: 5 })).toEqual({ changes: {}, before: {} })
    expect(diffFields(p, { name: 'Eau 1.5L', minStock: 5, active: undefined })).toEqual({ changes: { name: 'Eau 1.5L' }, before: { name: 'Eau' } })
  })
  it('clearing a barcode and setting one are both changes', () => {
    expect(diffFields(p, { barcode: '123' }).changes).toEqual({ barcode: '123' })
    expect(diffFields({ ...p, barcode: '123' }, { barcode: null })).toEqual({ changes: { barcode: null }, before: { barcode: '123' } })
    expect(diffFields(p, { barcode: null }).changes).toEqual({}) // already none
  })
})

describe('tax percent', () => {
  it('converts typed percentages exactly', () => {
    expect(percentToBp('19.25')).toBe(1925)
    expect(percentToBp('19,25')).toBe(1925)
    expect(percentToBp('0')).toBe(0)
    expect(percentToBp(' 5 ')).toBe(500)
    for (const bad of ['', 'abc', '19.255', '-1', '1000']) expect(percentToBp(bad)).toBeNull()
    expect(bpToPercent(1925)).toBe('19.25')
  })
})
