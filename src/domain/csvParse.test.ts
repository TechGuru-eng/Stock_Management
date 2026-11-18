import { describe, expect, it } from 'vitest'
import { decodeFile, detectDelimiter, mapHeaders, parseAmount, parseCsv } from './csvParse'

describe('reading CSV', () => {
  it('handles Excel files: BOM, semicolons, CRLF, blank lines', () => {
    const text = '﻿nom;prix\r\nEau;500\r\n\r\nRiz;1 000\r\n'
    expect(parseCsv(text)).toEqual([['nom', 'prix'], ['Eau', '500'], ['Riz', '1 000']])
  })
  it('detects the separator from the header', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',')
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t')
    expect(detectDelimiter('"a;b",c')).toBe(',') // a ; inside quotes is not a separator
    expect(detectDelimiter('single')).toBe(',')
  })
  it('quoted cells may hold separators, quotes and line breaks', () => {
    const rows = parseCsv('name,note\n"Eau; 1.5L","dit ""pure""\nsur 2 lignes"\nRiz,')
    expect(rows).toEqual([['name', 'note'], ['Eau; 1.5L', 'dit "pure"\nsur 2 lignes'], ['Riz', '']])
  })
  it('keeps empty cells in place and a last row without a final newline', () => {
    expect(parseCsv('a,b,c\n1,,3\n4,5,6')).toEqual([['a', 'b', 'c'], ['1', '', '3'], ['4', '5', '6']])
  })
})

describe('file encodings', () => {
  it('UTF-8 is read as is; Windows-1252 (old Excel) is rescued instead of showing garbage', () => {
    const utf8 = new TextEncoder().encode('Crème brûlée')
    expect(decodeFile(utf8)).toBe('Crème brûlée')
    const cp1252 = Uint8Array.from([0x43, 0x72, 0xe8, 0x6d, 0x65]) // "Crème" with è = 0xE8
    expect(decodeFile(cp1252)).toBe('Crème')
  })
})

describe('header names', () => {
  it('knows French and English column names, in any order, ignoring unknown columns', () => {
    expect(mapHeaders(['Désignation', 'Code-barres', 'Prix de vente', 'Commentaire', 'Stock minimum', 'TVA'])).toEqual({ name: 0, barcode: 1, price: 2, minStock: 4, taxPercent: 5 })
    expect(mapHeaders(['name', 'EAN', 'unit', 'price', 'sku'])).toEqual({ name: 0, barcode: 1, unit: 2, price: 3, sku: 4 })
  })
})

describe('amounts', () => {
  it('reads FCFA as people write it', () => {
    for (const [raw, n] of [['1500', 1500], ['1 500', 1500], ['1 500', 1500], ['1 500 FCFA', 1500], ['1.500', 1500], ['1,500', 1500], ['2 500F', 2500], ['0', 0], ['12.345.678', 12345678]] as const) {
      expect(parseAmount(raw), raw).toBe(n)
    }
  })
  it('refuses what is not a whole amount, instead of guessing', () => {
    for (const raw of ['', 'abc', '1500.50', '15,5', '-5', '1e3', '1.5', '12 34a']) expect(parseAmount(raw), raw).toBeNull()
  })
})
