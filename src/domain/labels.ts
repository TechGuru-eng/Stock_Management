import { describeBarcode, cleanBarcode } from './barcode'

/**
 * Label printing rules: which sheet layouts exist, where each label goes, which barcode type a code needs, and how the
 * black-and-white bars are described. Pure; the PDF drawing lives elsewhere.
 */
export interface SheetPreset {
  id: string
  name: string
  /** Page size in mm (a roll of labels is a page the size of one label). */
  pageW: number
  pageH: number
  cols: number
  rows: number
  labelW: number
  labelH: number
  /** Distance from the page edge to the first label. */
  marginX: number
  marginY: number
  /** Space between labels. */
  gapX: number
  gapY: number
}

export const SHEETS: readonly SheetPreset[] = [
  { id: 'a4-21', name: 'A4 sheet, 21 labels (3 x 7, 63.5 x 38.1 mm)', pageW: 210, pageH: 297, cols: 3, rows: 7, labelW: 63.5, labelH: 38.1, marginX: 7.2, marginY: 15.15, gapX: 2.5, gapY: 0 },
  { id: 'a4-24', name: 'A4 sheet, 24 labels (3 x 8, 70 x 37 mm)', pageW: 210, pageH: 297, cols: 3, rows: 8, labelW: 70, labelH: 37, marginX: 0, marginY: 0.5, gapX: 0, gapY: 0 },
  { id: 'a4-65', name: 'A4 sheet, 65 small labels (5 x 13, 38.1 x 21.2 mm)', pageW: 210, pageH: 297, cols: 5, rows: 13, labelW: 38.1, labelH: 21.2, marginX: 4.7, marginY: 10.7, gapX: 2.5, gapY: 0 },
  { id: 'roll-50x30', name: 'Label roll 50 x 30 mm (one per page)', pageW: 50, pageH: 30, cols: 1, rows: 1, labelW: 50, labelH: 30, marginX: 0, marginY: 0, gapX: 0, gapY: 0 },
  { id: 'roll-40x25', name: 'Label roll 40 x 25 mm (one per page)', pageW: 40, pageH: 25, cols: 1, rows: 1, labelW: 40, labelH: 25, marginX: 0, marginY: 0, gapX: 0, gapY: 0 },
]

export const sheetById = (id: string): SheetPreset => SHEETS.find((s) => s.id === id) ?? SHEETS[0]
export const labelsPerPage = (s: SheetPreset): number => s.cols * s.rows

export interface Slot {
  /** Position of the label's top-left corner on the page, in mm. */
  x: number
  y: number
  /** Which label of the print job goes here. */
  index: number
}

export const MAX_COPIES = 200
export const MAX_LABELS = 2000

/**
 * Splits `total` labels over pages. `startCell` (0-based) skips cells already used on a partly used sheet, so a sheet of
 * stickers is never wasted. Cells are filled left to right, top to bottom.
 */
export function layoutPages(sheet: SheetPreset, total: number, startCell = 0): Slot[][] {
  const per = labelsPerPage(sheet)
  const start = Math.min(Math.max(Math.floor(startCell), 0), per - 1)
  const pages: Slot[][] = []
  for (let i = 0; i < total; i++) {
    const cell = start + i
    const page = Math.floor(cell / per)
    const inPage = cell % per
    const col = inPage % sheet.cols
    const row = Math.floor(inPage / sheet.cols)
    ;(pages[page] ??= []).push({ x: sheet.marginX + col * (sheet.labelW + sheet.gapX), y: sheet.marginY + row * (sheet.labelH + sheet.gapY), index: i })
  }
  return pages
}

/** The sheet really fits on its page (a mistyped preset would print off the paper). */
export function sheetFits(s: SheetPreset): boolean {
  const w = s.marginX + s.cols * s.labelW + (s.cols - 1) * s.gapX
  const h = s.marginY + s.rows * s.labelH + (s.rows - 1) * s.gapY
  return w <= s.pageW + 0.01 && h <= s.pageH + 0.01
}

/* ------------------------------ what to print ------------------------------ */

export interface LabelRequest {
  productId: string
  copies: number
}

export function clampCopies(n: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 0), MAX_COPIES) : 0
}

export interface LabelItem {
  productId: string
  name: string
  /** Selling price of the base unit in FCFA, or null to leave the price off. */
  price: number | null
  code: string
}

/** One entry per label to print (copies repeated), in the order requested. Products without a code are skipped and reported. */
export function expandLabels(
  requests: readonly LabelRequest[],
  products: ReadonlyMap<string, { name: string; barcode?: string; price: number | null }>,
  withPrice: boolean,
): { items: LabelItem[]; skipped: string[]; truncated: boolean } {
  const items: LabelItem[] = []
  const skipped: string[] = []
  let truncated = false
  for (const r of requests) {
    const p = products.get(r.productId)
    const copies = clampCopies(r.copies)
    if (!p || copies === 0) continue
    if (!p.barcode) { skipped.push(p.name); continue }
    for (let i = 0; i < copies; i++) {
      if (items.length >= MAX_LABELS) { truncated = true; break }
      items.push({ productId: r.productId, name: p.name, price: withPrice ? p.price : null, code: cleanBarcode(p.barcode) })
    }
  }
  return { items, skipped, truncated }
}

/* --------------------------------- barcodes --------------------------------- */

export type BarFormat = 'EAN13' | 'EAN8' | 'UPC' | 'CODE128'

/**
 * Which bar pattern a code needs. Standard retail codes with a correct check digit use their own pattern (so scanners treat them
 * as retail codes); anything else, including a retail-looking code with a wrong digit, is printed as Code 128 so it still scans.
 */
export function barFormat(code: string): BarFormat {
  const d = describeBarcode(code)
  if (d.checksumOk) {
    if (d.kind === 'ean13') return 'EAN13'
    if (d.kind === 'ean8') return 'EAN8'
    if (d.kind === 'upca') return 'UPC'
  }
  return 'CODE128'
}

export interface Bar {
  /** Start, in modules (the narrowest bar is 1 module wide). */
  at: number
  /** Width in modules. */
  width: number
}

/** Turns a string of 1s (bar) and 0s (space) into the black bars to draw, joining neighbours. */
export function barsFromBits(bits: string): { bars: Bar[]; modules: number } {
  const bars: Bar[] = []
  let i = 0
  while (i < bits.length) {
    if (bits[i] === '1') {
      let j = i
      while (j < bits.length && bits[j] === '1') j++
      bars.push({ at: i, width: j - i })
      i = j
    } else i++
  }
  return { bars, modules: bits.length }
}
