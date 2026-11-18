import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { cleanBarcode, REPEAT_IGNORE_MS } from '../domain/barcode'
import { feedback, plausible, ScannerError, startScanning, type ScanSession } from './engine'

/**
 * Full-screen camera scanner. `continuous` keeps it open after each read (a cashier scanning a basket); otherwise it closes
 * after the first code. A typed code is always possible, so a dirty label or a refused camera never blocks a sale.
 * `onCode` returns a short message to show (e.g. "Eau 1.5L added") or null.
 */
export function CameraScanner({ onCode, onClose, continuous = false }: { onCode: (code: string) => string | null | void; onClose: () => void; continuous?: boolean }) {
  const { t } = useTranslation()
  const video = useRef<HTMLVideoElement>(null)
  const session = useRef<ScanSession | null>(null)
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 })
  const [error, setError] = useState<string | null>(null)
  const [torch, setTorch] = useState<boolean | null>(null)
  const [on, setOn] = useState(false)
  const [info, setInfo] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const handler = useRef(onCode)
  useEffect(() => { handler.current = onCode })

  const accept = (raw: string) => {
    const code = cleanBarcode(raw)
    if (!code || !plausible(code)) return // a misread digit: wait for the next frame
    const now = Date.now()
    if (code === last.current.code && now - last.current.at < REPEAT_IGNORE_MS) return // same item still in view
    last.current = { code, at: now }
    feedback()
    const msg = handler.current(code)
    setInfo(typeof msg === 'string' ? msg : null)
    if (!continuous) onClose()
  }
  const acceptRef = useRef(accept)
  useEffect(() => { acceptRef.current = accept })

  useEffect(() => {
    let live = true
    const el = video.current
    if (!el) return
    startScanning(el, (c) => acceptRef.current(c)).then(
      (s) => {
        if (!live) { s.stop(); return }
        session.current = s
        setTorch(s.torchSupported)
      },
      (e: unknown) => live && setError(e instanceof ScannerError ? e.code : 'no_camera'),
    )
    return () => {
      live = false
      session.current?.stop()
      session.current = null
    }
  }, [])

  function submitTyped(e: FormEvent) {
    e.preventDefault()
    const code = cleanBarcode(typed)
    if (!code) return
    last.current = { code: '', at: 0 }
    setTyped('')
    feedback()
    const msg = handler.current(code)
    setInfo(typeof msg === 'string' ? msg : null)
    if (!continuous) onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label={t('scan.title')}>
      <div className="flex items-center justify-between p-3">
        <h2 className="text-lg font-semibold">{t('scan.title')}</h2>
        <button onClick={onClose} className="min-h-12 rounded border border-white/60 px-4">{continuous ? t('scan.done') : t('scan.close')}</button>
      </div>
      <div className="relative flex-1">
        <video ref={video} className="h-full w-full object-cover" muted playsInline />
        {!error && <div className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded border-2 border-teal-400" aria-hidden="true" />}
        {error && <p role="alert" className="absolute inset-x-4 top-8 rounded bg-red-900/90 p-3">{t(`scan.errors.${error}`)}</p>}
      </div>
      <div className="flex flex-col gap-2 p-3">
        {info && <p role="status" className="rounded bg-teal-800 p-2 text-center">{info}</p>}
        {!error && <p className="text-center text-sm text-white/80">{t('scan.hint')}</p>}
        <div className="flex gap-2">
          {torch && (
            <button
              onClick={() => { const next = !on; void session.current?.setTorch(next).then(() => setOn(next)) }}
              className="min-h-12 rounded border border-white/60 px-4" aria-pressed={on}
            >
              {t('scan.light')}
            </button>
          )}
          <form onSubmit={submitTyped} className="flex flex-1 gap-2">
            <input
              className="min-h-12 w-full rounded bg-white px-3 text-black" inputMode="numeric" placeholder={t('scan.typeCode')} aria-label={t('scan.typeCode')}
              value={typed} onChange={(e) => setTyped(e.target.value)}
            />
            <button className="min-h-12 rounded bg-teal-600 px-4 font-semibold" disabled={!typed.trim()}>{t('scan.ok')}</button>
          </form>
        </div>
      </div>
    </div>
  )
}
