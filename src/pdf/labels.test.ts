import { describe, expect, it } from 'vitest'
import { barFormat, sheetById, type LabelItem } from '../domain/labels'
import { barBits, renderLabelsPdf } from './labelsPdf'

// Left-hand digit patterns of EAN-13 are the first six digits after the leading one: decode the bars back to the number.
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100']
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']

function decodeEan13(bits: string): string | null {
  if (bits.length !== 95 || !bits.startsWith('101') || bits.slice(45, 50) !== '01010' || !bits.endsWith('101')) return null
  const left = bits.slice(3, 45)
  const right = bits.slice(50, 92)
  let digits = ''
  let parity = ''
  for (let i = 0; i < 6; i++) {
    const chunk = left.slice(i * 7, i * 7 + 7)
    const l = L.indexOf(chunk)
    const g = G.indexOf(chunk)
    if (l >= 0) { digits += l; parity += 'L' } else if (g >= 0) { digits += g; parity += 'G' } else return null
  }
  const first = PARITY.indexOf(parity)
  if (first < 0) return null
  for (let i = 0; i < 6; i++) {
    const r = R.indexOf(right.slice(i * 7, i * 7 + 7))
    if (r < 0) return null
    digits += r
  }
  return `${first}${digits}`
}

describe('bar patterns', () => {
  it('an EAN-13 is 95 modules and decodes back to exactly the same number', () => {
    for (const code of ['5449000000996', '4006381333931', '2000000000008', '0036000291452']) {
      expect(decodeEan13(barBits(code)), code).toBe(code)
    }
  })
  it('other codes still produce bars (Code 128)', () => {
    expect(barFormat('AB-12')).toBe('CODE128')
    expect(barBits('AB-12')).toMatch(/^1[01]+1$/)
    expect(barBits('AB-12').length).toBeGreaterThan(30)
  })
})

describe('the label PDF', () => {
  const item = (i: number): LabelItem => ({ productId: `p${i}`, name: i === 1 ? 'Eau minérale naturelle 1.5 litre bouteille plastique pack économique' : `Produit ${i}`, price: 500 + i, code: '5449000000996' })
  it('is a real PDF with a page per sheet, and the names, prices and numbers on it', async () => {
    const items = Array.from({ length: 30 }, (_, i) => item(i))
    const bytes = await renderLabelsPdf(items, sheetById('a4-24'))
    const text = new TextDecoder('latin1').decode(bytes)
    expect(text.startsWith('%PDF-')).toBe(true)
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBe(2)
    for (const s of ['Produit 5', '5449000000996', '505 FCFA']) expect(text).toContain(s)
  })
  it('a roll makes one page per label, of the label size', async () => {
    const text = new TextDecoder('latin1').decode(await renderLabelsPdf([item(2), item(3)], sheetById('roll-50x30')))
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBe(2)
    expect(text).toMatch(/\/MediaBox \[0 0 141\.73\d* 85\.03\d*\]/) // 50 x 30 mm in points
  })
  it('can leave the price off and start part-way down a sheet', async () => {
    const bytes = await renderLabelsPdf([{ ...item(2), price: null }], sheetById('a4-21'), { startCell: 5, guides: true })
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('FCFA')
  })
})
