import { lazy, Suspense, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

const CameraScanner = lazy(() => import('./CameraScanner').then((m) => ({ default: m.CameraScanner })))

/** A camera button next to a search or barcode field. The scanner code is only loaded when it is first opened. */
export function ScanButton({ onCode, continuous, className }: { onCode: (code: string) => string | null | void; continuous?: boolean; className?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button" onClick={() => setOpen(true)} aria-label={t('scan.open')} title={t('scan.open')}
        className={className ?? 'min-h-12 shrink-0 rounded border border-slate-300 px-3'}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 8v8M11 8v8M14 8v8M17 8v8" />
        </svg>
      </button>
      {/* Rendered at the top of the page: the scanner has its own form, which must not sit inside the till's form. */}
      {open && createPortal(
        <Suspense fallback={null}>
          <CameraScanner continuous={continuous} onCode={onCode} onClose={() => setOpen(false)} />
        </Suspense>,
        document.body,
      )}
    </>
  )
}
