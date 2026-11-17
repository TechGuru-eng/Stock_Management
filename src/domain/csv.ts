export type Cell = string | number | null | undefined

export interface Column<T> {
  label: string
  value: (row: T) => Cell
}

/**
 * Spreadsheet-friendly CSV.
 *  - Separator: ";" for French settings of Excel, "," for English ones (the caller chooses).
 *  - A byte-order mark so Excel reads accents (é, è, ç) correctly.
 *  - Text that starts with = + - @ (or tab / return) could be run as a formula when the file is opened, so it gets a
 *    leading apostrophe. Numbers are written as plain numbers and are never touched.
 */
export function toCsv<T>(columns: readonly Column<T>[], rows: readonly T[], sep: ';' | ',' = ';'): string {
  const esc = (c: Cell): string => {
    if (c === null || c === undefined) return ''
    if (typeof c === 'number') return Number.isFinite(c) ? String(c) : ''
    let s = c
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /["\r\n;,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [columns.map((c) => esc(c.label)).join(sep), ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(sep))]
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/** Download a text file in the browser (nothing is uploaded anywhere). */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A safe file name such as `stockcm-sales-by-product-2026-11-17.csv`. */
export function reportFileName(kind: string, ymd: string): string {
  return `stockcm-${kind.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${ymd}.csv`
}
