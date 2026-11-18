import JsBarcode from 'jsbarcode'
import { barFormat, barsFromBits, layoutPages, type LabelItem, type SheetPreset } from '../domain/labels'
import { moneyText } from '../domain/reminders'

/**
 * Barcode labels as a PDF. The bar patterns come from the `jsbarcode` encoder (it only produces 1s and 0s here; the bars are
 * drawn as plain rectangles), so the file is crisp at any printer resolution and works offline.
 */

/** The black (1) and white (0) modules of a code, quiet zones removed. EAN-13 is exactly 95 modules. */
export function barBits(code: string): string {
  const out: { encodings?: { data: string }[] } = {}
  JsBarcode(out, code, { format: barFormat(code), displayValue: false })
  const bits = (out.encodings ?? []).map((e) => e.data).join('')
  return bits.replace(/^0+/, '').replace(/0+$/, '')
}

export interface LabelOptions {
  /** 0-based first cell to use on the first sheet (a partly used sheet). */
  startCell?: number
  /** Draw a thin cutting outline around each label (for plain paper). */
  guides?: boolean
}

export async function renderLabelsPdf(items: readonly LabelItem[], sheet: SheetPreset, opts: LabelOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: [sheet.pageW, sheet.pageH], orientation: sheet.pageW > sheet.pageH ? 'landscape' : 'portrait', compress: false })
  doc.setProperties({ title: 'StockCM labels', creator: 'StockCM' })
  const pages = layoutPages(sheet, items.length, opts.startCell ?? 0)
  const cache = new Map<string, ReturnType<typeof barsFromBits>>()

  pages.forEach((slots, p) => {
    if (p > 0) doc.addPage([sheet.pageW, sheet.pageH], sheet.pageW > sheet.pageH ? 'landscape' : 'portrait')
    for (const slot of slots) {
      const item = items[slot.index]
      const { x, y } = slot
      const w = sheet.labelW
      const h = sheet.labelH
      const small = h < 26
      const pad = Math.min(2.2, w * 0.05)

      if (opts.guides) doc.setDrawColor(190).setLineWidth(0.1).rect(x, y, w, h)

      // name (up to two lines, one on small labels)
      doc.setFont('helvetica', 'bold').setFontSize(small ? 6.5 : 8.5).setTextColor(0)
      const maxLines = small ? 1 : 2
      let lines = doc.splitTextToSize(item.name, w - 2 * pad) as string[]
      if (lines.length > maxLines) lines = [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1].replace(/\s+\S*$/, '').slice(0, 40)}…`]
      const lineH = small ? 2.6 : 3.4
      lines.forEach((l, i) => doc.text(l, x + pad, y + pad + 2.4 + i * lineH))
      const nameBottom = y + pad + 2.4 + (lines.length - 1) * lineH + 1

      // bars
      const textRow = small ? 2.8 : 3.4
      const bottom = y + h - pad
      const barTop = nameBottom + 0.6
      const barH = Math.max(bottom - textRow - barTop - 0.3, 6)
      let parsed = cache.get(item.code)
      if (!parsed) cache.set(item.code, (parsed = barsFromBits(barBits(item.code))))
      const usable = w - 2 * pad
      const module = Math.min(usable / parsed.modules, 0.5)
      const left = x + (w - parsed.modules * module) / 2
      doc.setFillColor(0, 0, 0)
      for (const b of parsed.bars) doc.rect(left + b.at * module, barTop, b.width * module, barH, 'F')

      // number (left) and price (right)
      doc.setFont('helvetica', 'normal').setFontSize(small ? 6 : 7).setTextColor(0)
      doc.text(item.code, x + pad, bottom, { baseline: 'bottom' })
      if (item.price !== null) {
        doc.setFont('helvetica', 'bold').setFontSize(small ? 8.5 : 11)
        doc.text(moneyText(item.price), x + w - pad, bottom + 0.3, { align: 'right', baseline: 'bottom' })
      }
    }
  })
  if (pages.length === 0) doc.text(' ', 1, 1)
  return new Uint8Array(doc.output('arraybuffer'))
}
