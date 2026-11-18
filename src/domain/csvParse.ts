/**
 * Reading spreadsheet exports (CSV). Handles what real files from Excel, Google Sheets and phones contain: a byte-order mark,
 * `;` or `,` or tab as separator, quoted cells with separators / quotes / line breaks inside, CRLF line endings, empty lines.
 */

export function detectDelimiter(text: string): ';' | ',' | '\t' {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  // ignore anything inside quotes when counting
  const bare = firstLine.replace(/"[^"]*"/g, '')
  const count = (c: string) => bare.split(c).length - 1
  const options: [';' | ',' | '\t', number][] = [[';', count(';')], [',', count(',')], ['\t', count('\t')]]
  options.sort((a, b) => b[1] - a[1])
  return options[0][1] > 0 ? options[0][0] : ','
}

export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const src = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let any = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ } else inQuotes = false
      } else cell += c
      continue
    }
    if (c === '"' && cell === '') { inQuotes = true; any = true; continue }
    if (c === delimiter) { row.push(cell); cell = ''; any = true; continue }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++
      if (any || cell !== '') { row.push(cell); rows.push(row) }
      row = []; cell = ''; any = false
      continue
    }
    cell += c
    any = true
  }
  if (any || cell !== '') { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/**
 * Bytes of a file to text. Files saved by Excel in French are often Windows-1252, not UTF-8: reading them as UTF-8 would turn
 * é into garbage. UTF-8 is tried strictly first; if the bytes are not valid UTF-8 they are read as Windows-1252.
 */
export function decodeFile(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8)
  } catch {
    return new TextDecoder('windows-1252').decode(u8)
  }
}

/* ------------------------------ headers ------------------------------ */

export type Field = 'name' | 'barcode' | 'sku' | 'unit' | 'price' | 'minStock' | 'taxPercent'

const ALIASES: Record<Field, string[]> = {
  name: ['name', 'nom', 'nom du produit', 'produit', 'product', 'designation', 'désignation', 'article', 'libelle', 'libellé', 'description'],
  barcode: ['barcode', 'code-barres', 'code barres', 'code barre', 'codebarres', 'code', 'ean', 'gtin', 'upc'],
  sku: ['sku', 'reference', 'référence', 'ref', 'réf'],
  unit: ['unit', 'unite', 'unité', 'unite de vente', 'unité de vente', 'conditionnement'],
  price: ['price', 'prix', 'prix de vente', 'prix vente', 'prix (fcfa)', 'prix fcfa', 'selling price', 'pv', 'tarif', 'prix unitaire'],
  minStock: ['min_stock', 'min stock', 'minimum stock', 'stock minimum', 'stock min', 'alerte stock minimum', 'seuil', 'seuil alerte'],
  taxPercent: ['tax_percent', 'tax', 'tva', 'taxe', 'taxe (%)', 'tax (%)', 'tax rate', 'taux de taxe', 'tva (%)'],
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** Which column holds which field, found from the header row (French or English names). Unknown columns are ignored. */
export function mapHeaders(header: readonly string[]): Partial<Record<Field, number>> {
  const out: Partial<Record<Field, number>> = {}
  header.forEach((h, i) => {
    const n = norm(h)
    for (const f of Object.keys(ALIASES) as Field[]) {
      if (out[f] === undefined && ALIASES[f].includes(n)) out[f] = i
    }
  })
  return out
}

/* ------------------------------ numbers ------------------------------ */

/**
 * A whole amount of FCFA as people write it: "1500", "1 500", "1 500 FCFA", "1.500", "1,500", "1500F". Anything with real decimals
 * ("1500.50", "15,5") is refused instead of guessed, because a price is a whole number of FCFA.
 */
export function parseAmount(raw: string): number | null {
  let t = raw.replace(/[\s  ]/g, '').replace(/fcfa|f\.?cfa|xaf|cfa|f$/gi, '')
  if (t === '') return null
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, '') // thousands separators
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return Number.isSafeInteger(n) ? n : null
}
