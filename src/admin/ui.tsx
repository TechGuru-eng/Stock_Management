import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SubState } from './api'

export const fmtXaf = (n: number | null | undefined) => (n == null ? '—' : `${n.toLocaleString('fr-FR').replace(/ /g, ' ')} FCFA`)
export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
export const fmtTime = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never')

export function ago(s: string | null): string {
  if (!s) return 'never'
  const d = (Date.now() - new Date(s).getTime()) / 3_600_000
  if (d < 1) return 'just now'
  if (d < 48) return `${Math.round(d)} h ago`
  return `${Math.round(d / 24)} days ago`
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true })
  const run = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }))
    fn().then(
      (data) => setState({ data, error: null, loading: false }),
      (e: unknown) => setState({ data: null, error: e instanceof Error ? e.message : 'Something went wrong', loading: false }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(run, [run])
  return { ...state, reload: run }
}

export const inputCls = 'field__input'

export function Button({ children, onClick, kind = 'primary', disabled, type = 'button' }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; type?: 'button' | 'submit'
}) {
  const k = kind === 'primary' ? 'btn--primary' : kind === 'danger' ? 'btn--danger' : 'btn--secondary'
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`btn ${k}`}>
      {children}
    </button>
  )
}

export function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="panel">
      {(title || action) && (
        <div className="panel__head">
          {title && <h2 className="h6">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className={`stat-tile${tone ? ' stat-tile--flag' : ''}`}>
      <div className="label-lg muted">{label}</div>
      <div className="stat-tile__value h3">{value}</div>
      {hint && <div className="stat-tile__hint body-sm">{hint}</div>}
    </div>
  )
}

const BADGE: Record<string, string> = {
  trial: 'tag--outline', active: 'tag--solid', grace: 'tag--flag',
  expired: 'tag--flag', suspended: 'tag--flag',
  pending: 'tag--outline', recorded: 'tag--solid', provider_verified: 'tag--solid',
  failed: 'tag--flag', refunded: '',
}
export function Badge({ value }: { value: SubState | string }) {
  return <span className={`tag ${BADGE[value] ?? ''}`}>{value.replace('_', ' ')}</span>
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null
  return <p role="alert" className="field__error">{message}</p>
}

export function Loading() {
  return <p className="body-md muted" style={{ padding: '24px 0', textAlign: 'center' }}>Loading…</p>
}

/** Asks for a written reason before a sensitive action. The reason is stored in the audit log. */
export function ReasonDialog({ title, description, label = 'Reason', minLength = 5, confirmText, danger, extra, onConfirm, onClose }: {
  title: string; description?: string; label?: string; minLength?: number; confirmText: string; danger?: boolean
  extra?: ReactNode; onConfirm: (reason: string) => Promise<void>; onClose: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const ok = reason.trim().length >= minLength
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <h3 className="h5">{title}</h3>
        {description && <p className="body-md muted">{description}</p>}
        {extra}
        <label className="field">
          <span>{label} <span style={{ textTransform: 'none' }}>(at least {minLength} characters, saved in the audit log)</span></span>
          <textarea ref={ref} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="input" />
        </label>
        <ErrorNote message={error} />
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <Button kind="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            kind={danger ? 'danger' : 'primary'}
            disabled={!ok || busy}
            onClick={() => {
              setBusy(true); setError(null)
              onConfirm(reason.trim()).then(onClose, (e: unknown) => { setError(e instanceof Error ? e.message : 'Failed'); setBusy(false) })
            }}
          >
            {busy ? 'Working…' : confirmText}
          </Button>
        </div>
      </div>
    </div>
  )
}
