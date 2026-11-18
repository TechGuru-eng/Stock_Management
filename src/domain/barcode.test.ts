import { describe, expect, it } from 'vitest'
import { barcodeKey, checkDigit, cleanBarcode, describeBarcode, findByBarcode, internalEan, looksLikeScan, nextInternalEan, sameBarcode } from './barcode'

describe('check digits (real codes)', () => {
  it('knows valid EAN-13, EAN-8, UPC-A and ITF-14 codes', () => {
    expect(describeBarcode('4006381333931')).toEqual({ kind: 'ean13', checksumOk: true }) // Stabilo
    expect(describeBarcode('5449000000996')).toEqual({ kind: 'ean13', checksumOk: true }) // Coca-Cola
    expect(describeBarcode('96385074')).toEqual({ kind: 'ean8', checksumOk: true })
    expect(describeBarcode('036000291452')).toEqual({ kind: 'upca', checksumOk: true })
    expect(describeBarcode('10012345678902')).toEqual({ kind: 'itf14', checksumOk: true })
  })
  it('catches a misread digit', () => {
    expect(describeBarcode('4006381333932').checksumOk).toBe(false)
    expect(describeBarcode('96385075').checksumOk).toBe(false)
  })
  it('other codes (letters, odd lengths, shop-made labels) are accepted without a checksum', () => {
    expect(describeBarcode('ABC-123')).toEqual({ kind: 'other', checksumOk: null })
    expect(describeBarcode('12345')).toEqual({ kind: 'other', checksumOk: null })
  })
  it('computes the digit', () => {
    expect(checkDigit('400638133393')).toBe(1)
  })
})

describe('matching what was scanned to what is stored', () => {
  it('ignores spaces, line breaks and case', () => {
    expect(cleanBarcode(' 4006 3813\n33931\r')).toBe('4006381333931')
    expect(cleanBarcode('ab-12 c')).toBe('AB-12C')
  })
  it('UPC-A and EAN-13 spellings of the same code are the same product', () => {
    expect(barcodeKey('036000291452')).toBe('0036000291452')
    expect(sameBarcode('036000291452', '0036000291452')).toBe(true)
    expect(sameBarcode('036000291452', '0036000291453')).toBe(false)
  })
  it('finds the product, or nothing', () => {
    const ps = [{ id: 1, barcode: '5449000000996' }, { id: 2, barcode: '0036000291452' }, { id: 3 }]
    expect(findByBarcode(ps, ' 5449000000996 ')?.id).toBe(1)
    expect(findByBarcode(ps, '036000291452')?.id).toBe(2)
    expect(findByBarcode(ps, '')).toBeUndefined()
    expect(findByBarcode(ps, '1111111111116')).toBeUndefined()
  })
})

describe('in-store codes for goods without a barcode', () => {
  it('are valid EAN-13 numbers in the reserved "2" range', () => {
    const c = internalEan(42)
    expect(c).toMatch(/^20\d{11}$/)
    expect(c).toHaveLength(13)
    expect(describeBarcode(c)).toEqual({ kind: 'ean13', checksumOk: true })
  })
  it('the next one never reuses a code in use, and ignores manufacturers\' codes', () => {
    expect(nextInternalEan([])).toBe(internalEan(0))
    expect(nextInternalEan(['5449000000996', undefined])).toBe(internalEan(0))
    expect(nextInternalEan([internalEan(0), internalEan(1), internalEan(7)])).toBe(internalEan(8))
  })
  it('refuses silly sequence numbers', () => {
    expect(() => internalEan(-1)).toThrow()
    expect(() => internalEan(1.5)).toThrow()
  })
})

describe('telling a scanner from a person typing', () => {
  it('a fast burst is a scan; slow typing and short bursts are not', () => {
    const burst = Array.from({ length: 13 }, (_, i) => i * 12)
    expect(looksLikeScan(burst)).toBe(true)
    expect(looksLikeScan(Array.from({ length: 13 }, (_, i) => i * 250))).toBe(false)
    expect(looksLikeScan([0, 10, 20])).toBe(false)
    expect(looksLikeScan([...burst.slice(0, 6), 600, 612])).toBe(false) // a pause in the middle
  })
})
