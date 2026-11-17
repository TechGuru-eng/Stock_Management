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

export const inputCls = 'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20 disabled:bg-slate-100'

export function Button({ children, onClick, kind = 'primary', disabled, type = 'button' }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; type?: 'button' | 'submit'
}) {
  const k = kind === 'primary' ? 'bg-teal-700 text-white hover:bg-teal-800' : kind === 'danger' ? 'bg-red-600 text-white hover:bg-red-700' : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${k}`}>
      {children}
    </button>
  )
}

export function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warn' | 'bad' }) {
  const c = tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-900'
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${c}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  )
}

const BADGE: Record<string, string> = {
  trial: 'bg-sky-100 text-sky-800', active: 'bg-emerald-100 text-emerald-800', grace: 'bg-amber-100 text-amber-800',
  expired: 'bg-red-100 text-red-800', suspended: 'bg-slate-800 text-white',
  pending: 'bg-amber-100 text-amber-800', recorded: 'bg-emerald-100 text-emerald-800', provider_verified: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800', refunded: 'bg-slate-200 text-slate-800',
}
export function Badge({ value }: { value: SubState | string }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[value] ?? 'bg-slate-100 text-slate-700'}`}>{value.replace('_', ' ')}</span>
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null
  return <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{message}</p>
}

export function Loading() {
  return <p className="py-6 text-center text-sm text-slate-500">Loading…</p>
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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
        {extra && <div className="mt-3">{extra}</div>}
        <label className="mt-3 block text-sm font-medium text-slate-700">
          {label} <span className="font-normal text-slate-500">(at least {minLength} characters, saved in the audit log)</span>
          <textarea ref={ref} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputCls} mt-1`} />
        </label>
        <div className="mt-3"><ErrorNote message={error} /></div>
        <div className="mt-4 flex justify-end gap-2">
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
