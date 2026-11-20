import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import '../marketing/editorial/styles.css'
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
    <div className="editorial-taste on-dark" style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', flexDirection: 'column', background: 'var(--dark-100)', color: 'var(--light-100)' }} role="dialog" aria-modal="true" aria-label={t('scan.title')}>
      <div className="flex items-center justify-between" style={{ padding: 15 }}>
        <h2 className="h6">{t('scan.title')}</h2>
        <button onClick={onClose} className="btn btn--glass">{continuous ? t('scan.done') : t('scan.close')}</button>
      </div>
      <div style={{ position: 'relative', flex: 1 }}>
        <video ref={video} style={{ height: '100%', width: '100%', objectFit: 'cover' }} muted playsInline />
        {!error && <div style={{ pointerEvents: 'none', position: 'absolute', left: 32, right: 32, top: '50%', height: 96, transform: 'translateY(-50%)', borderRadius: 'var(--radius-10)', border: '2px solid var(--light-100)' }} aria-hidden="true" />}
        {error && <p role="alert" className="body-md" style={{ position: 'absolute', left: 16, right: 16, top: 32, background: 'var(--dark-88)', borderRadius: 'var(--radius-10)', padding: 15 }}>! {t(`scan.errors.${error}`)}</p>}
      </div>
      <div className="stack" style={{ padding: 15 }}>
        {info && <p role="status" className="body-md" style={{ background: 'var(--light-16)', backdropFilter: 'var(--blur-glass)', borderRadius: 'var(--radius-10)', padding: 10, textAlign: 'center' }}>{info}</p>}
        {!error && <p className="body-sm" style={{ textAlign: 'center', color: 'var(--light-64)' }}>{t('scan.hint')}</p>}
        <div className="flex gap-2">
          {torch && (
            <button
              onClick={() => { const next = !on; void session.current?.setTorch(next).then(() => setOn(next)) }}
              className="btn btn--glass" aria-pressed={on}
            >
              {t('scan.light')}
            </button>
          )}
          <form onSubmit={submitTyped} className="flex flex-1 gap-2">
            <input
              className="input" style={{ background: 'var(--neutral-white)', color: 'var(--dark-100)' }} inputMode="numeric" placeholder={t('scan.typeCode')} aria-label={t('scan.typeCode')}
              value={typed} onChange={(e) => setTyped(e.target.value)}
            />
            <button className="btn btn--light" disabled={!typed.trim()}>{t('scan.ok')}</button>
          </form>
        </div>
      </div>
    </div>
  )
}
