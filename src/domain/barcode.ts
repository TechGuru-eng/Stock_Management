/**
 * Barcode rules. Pure: no camera, no screens. Used by the scanner, the till, the product form and counts.
 */

/** What a scanner or a person typed, made comparable: trimmed, no spaces, no control characters, upper-case letters. */
export function cleanBarcode(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f\s]/g, '').toUpperCase()
}

/** The check digit of a GTIN body (EAN-8, UPC-A, EAN-13, ITF-14 all use the same weighting from the right). */
export function checkDigit(body: string): number {
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i])
    sum += i % 2 === 0 ? d * 3 : d
  }
  return (10 - (sum % 10)) % 10
}

export type BarcodeKind = 'ean13' | 'ean8' | 'upca' | 'itf14' | 'other'

export interface BarcodeInfo {
  kind: BarcodeKind
  /** For the standard retail formats: does the last digit match the rest? A wrong digit means a misread. */
  checksumOk: boolean | null
}

export function describeBarcode(code: string): BarcodeInfo {
  const c = cleanBarcode(code)
  const kinds: Record<number, BarcodeKind> = { 13: 'ean13', 8: 'ean8', 12: 'upca', 14: 'itf14' }
  const kind = /^\d+$/.test(c) ? (kinds[c.length] ?? 'other') : 'other'
  if (kind === 'other') return { kind, checksumOk: null }
  return { kind, checksumOk: checkDigit(c.slice(0, -1)) === Number(c[c.length - 1]) }
}

/** UPC-A (12 digits) is the same code as EAN-13 with a leading zero; some scanners report one and some the other. */
export function barcodeKey(code: string): string {
  const c = cleanBarcode(code)
  return /^\d{12}$/.test(c) ? `0${c}` : c
}

export const sameBarcode = (a: string, b: string): boolean => barcodeKey(a) === barcodeKey(b)

/** The product with this barcode, if any (UPC-A and EAN-13 spellings of the same code match). */
export function findByBarcode<T extends { barcode?: string }>(products: readonly T[], code: string): T | undefined {
  const k = barcodeKey(code)
  if (!k) return undefined
  return products.find((p) => p.barcode && barcodeKey(p.barcode) === k)
}

/**
 * Codes for goods that have no barcode of their own, to stick on them. EAN-13 numbers starting with 2 are reserved for
 * in-store use and will never clash with a manufacturer's code: "20" + 10 digits + check digit.
 */
export function internalEan(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 9_999_999_999) throw new Error('sequence out of range')
  const body = `20${String(sequence).padStart(10, '0')}`
  return body + checkDigit(body)
}

/** The next unused in-store code, given the barcodes already in use. */
export function nextInternalEan(existing: readonly (string | undefined)[]): string {
  const used = new Set(existing.filter((x): x is string => Boolean(x)).map(barcodeKey))
  let max = -1
  for (const u of used) if (/^20\d{11}$/.test(u)) max = Math.max(max, Number(u.slice(2, 12)))
  let n = max + 1
  while (used.has(internalEan(n))) n++
  return internalEan(n)
}

/**
 * A keyboard-style scanner "types" a code in a burst and presses Enter. This tells a burst from a person typing:
 * at least `minLength` characters, each arriving within `maxGapMs` of the one before.
 */
export function looksLikeScan(times: readonly number[], minLength = 4, maxGapMs = 50): boolean {
  if (times.length < minLength) return false
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > maxGapMs) return false
  return true
}

/** The scanner reported the same code again within this time: probably the same item still in view. */
export const REPEAT_IGNORE_MS = 1500
