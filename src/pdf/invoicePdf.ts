import { moneyText } from '../domain/reminders'
import type { InvoiceData, Party } from '../domain/invoice'

/**
 * Draws an invoice as a real PDF (A4) in the browser. The library is loaded only when someone asks for a PDF, so it is not
 * part of the app's start-up. Works offline once the app has been loaded. Standard Helvetica font: accents are fine.
 */
const W = 210
const H = 297
const M = 15
const TEAL: [number, number, number] = [15, 118, 110]
const GREY: [number, number, number] = [100, 116, 139]

const money = (n: number) => moneyText(n)

export async function renderInvoicePdf(inv: InvoiceData): Promise<Uint8Array<ArrayBuffer>> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: false })
  doc.setProperties({ title: `${inv.title} ${inv.number}`, creator: 'StockCM', subject: inv.title })
  const L = inv.labels
  const date = new Date(inv.date).toLocaleDateString(inv.lang === 'fr' ? 'fr-FR' : 'en-GB', { day: '2-digit', month: 'long', year: 'numeric' })

  const party = (p: Party, x: number, y: number, width: number): number => {
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(0)
    const name = doc.splitTextToSize(p.name, width) as string[]
    doc.text(name, x, y)
    y += name.length * 5
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60)
    for (const line of [...(p.lines ?? []), ...(p.phone ? [p.phone] : []), ...(p.taxId ? [`NIU: ${p.taxId}`] : [])]) {
      for (const part of doc.splitTextToSize(line, width) as string[]) {
        doc.text(part, x, y)
        y += 4.2
      }
    }
    return y
  }

  // ---- header
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(...TEAL)
  doc.text(inv.title, W - M, M + 6, { align: 'right' })
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(60)
  doc.text(`${L.number} ${inv.number}`, W - M, M + 13, { align: 'right' })
  doc.text(`${L.date}: ${date}`, W - M, M + 18.5, { align: 'right' })

  doc.setFontSize(8).setTextColor(...GREY)
  doc.text(L.from.toUpperCase(), M, M + 4)
  let y = party(inv.seller, M, M + 10, 95)

  if (inv.buyer) {
    const by = Math.max(y + 6, M + 32)
    doc.setFontSize(8).setTextColor(...GREY)
    doc.text(L.to.toUpperCase(), M, by)
    y = party(inv.buyer, M, by + 6, 95)
  }
  y += 8

  // ---- table
  const colQty = 118
  const colPrice = 152
  const colAmt = W - M
  const header = () => {
    doc.setFillColor(...TEAL).rect(M, y, W - 2 * M, 8, 'F')
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(255)
    doc.text(L.description, M + 2, y + 5.4)
    doc.text(L.qty, colQty, y + 5.4, { align: 'right' })
    doc.text(L.unitPrice, colPrice, y + 5.4, { align: 'right' })
    doc.text(L.amount, colAmt - 2, y + 5.4, { align: 'right' })
    y += 8
  }
  header()
  doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(0)
  let stripe = false
  for (const l of inv.lines) {
    const desc = doc.splitTextToSize(l.description, colQty - M - 32) as string[]
    const h = Math.max(desc.length * 4.6, 5) + 3
    if (y + h > H - 55) {
      doc.addPage()
      y = M
      header()
      doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(0)
    }
    if (stripe) doc.setFillColor(243, 246, 248).rect(M, y, W - 2 * M, h, 'F')
    stripe = !stripe
    doc.setTextColor(0)
    doc.text(desc, M + 2, y + 5)
    doc.text(l.quantity, colQty, y + 5, { align: 'right' })
    doc.text(money(l.unitPrice), colPrice, y + 5, { align: 'right' })
    doc.text(money(l.amount), colAmt - 2, y + 5, { align: 'right' })
    y += h
  }
  doc.setDrawColor(200).line(M, y, W - M, y)
  y += 6

  // ---- totals (a block that must not be split across pages)
  const rows: [string, string, boolean?][] = [[L.subtotal, money(inv.subtotal)]]
  if (inv.discount > 0) rows.push([L.discount, `- ${money(inv.discount)}`])
  if (inv.tax > 0) rows.push([L.tax, money(inv.tax)])
  rows.push([L.total, money(inv.total), true])
  for (const p of inv.payments) rows.push([`${L.paid} — ${p.label}`, money(p.amount)])
  if (inv.returned > 0) rows.push([L.returned, `- ${money(inv.returned)}`])
  if (inv.balance > 0) rows.push([L.balance, money(inv.balance), true])
  const need = rows.length * 6.2 + 30
  if (y + need > H - M) {
    doc.addPage()
    y = M
  }
  for (const [label, value, bold] of rows) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(bold ? 11 : 9.5).setTextColor(bold ? 0 : 60)
    doc.text(label, colPrice + 8, y, { align: 'right' })
    doc.text(value, colAmt - 2, y, { align: 'right' })
    y += 6.2
  }
  if (inv.balance === 0 && inv.payments.length > 0) {
    y += 2
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...TEAL)
    doc.text(L.settled.toUpperCase(), colAmt - 2, y, { align: 'right' })
    y += 6
  }

  // ---- notes
  if (inv.notes.length) {
    y += 4
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60)
    for (const n of inv.notes) for (const part of doc.splitTextToSize(n, W - 2 * M) as string[]) { doc.text(part, M, y); y += 4.4 }
  }

  // ---- footer on every page
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...GREY)
    doc.text(`${inv.seller.name} · ${inv.number}`, M, H - 8)
    doc.text(`${L.page} ${p}/${pages}`, W - M, H - 8, { align: 'right' })
  }

  return new Uint8Array(doc.output('arraybuffer'))
}

/** Saves the PDF on the device. */
export function downloadPdf(filename: string, bytes: Uint8Array<ArrayBuffer>): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** On phones, opens the share sheet (WhatsApp, email…) with the PDF attached. Returns false when the device cannot do this. */
export async function sharePdf(filename: string, bytes: Uint8Array<ArrayBuffer>, title: string): Promise<boolean> {
  const file = new File([bytes], filename, { type: 'application/pdf' })
  if (!navigator.canShare?.({ files: [file] })) return false
  try {
    await navigator.share({ files: [file], title })
    return true
  } catch {
    return true // the person closed the share sheet: that is not an error
  }
}

export const invoiceFileName = (number: string) => `facture-${number.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`
