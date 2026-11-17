import { useState } from 'react'
import type { ReminderRow } from '../api'
import { useAdmin } from '../ctx'
import { RENEWAL_TEMPLATE, daysLeft, renderTemplate, renewalKind, waLink, type Lang } from '../../domain/reminders'
import { Badge, ErrorNote, fmtDate, Loading, useAsync } from '../ui'

const KIND_LABEL = { renewal_5d: 'Ends soon', renewal_2d: 'Ends very soon', grace_started: 'In grace period', expired: 'Expired' } as const

/**
 * Businesses that need a renewal nudge, with a button that opens WhatsApp with the message already typed.
 * A person presses Send: nothing is sent automatically. Opening a chat is recorded in the audit log.
 */
export function Reminders() {
  const { api } = useAdmin()
  const data = useAsync(() => api.reminders(), [api])
  const [lang, setLang] = useState<Record<string, Lang>>({})
  const [error, setError] = useState<string | null>(null)

  if (data.loading && !data.data) return <Loading />
  if (data.error || !data.data) return <ErrorNote message={data.error} />
  const { rows, grace_days, templates } = data.data

  const build = (r: ReminderRow, l: Lang) => {
    const days = daysLeft(r.period_end, new Date())
    const kind = renewalKind(days, grace_days) ?? 'renewal_5d'
    const custom = templates[kind]?.[l]?.trim()
    const text = renderTemplate(custom || RENEWAL_TEMPLATE[kind][l], {
      name: (r.owner_name ?? '').split(' ')[0], business: r.business, plan: r.plan_code, date: fmtDate(r.period_end), days: Math.max(days, 0),
    })
    return { kind, text, link: waLink(r.owner_phone, text), days }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Businesses whose subscription ends within 5 days or ended in the last 30 days. “Open WhatsApp” opens a chat with the message already
        typed; you press Send. Nothing is sent automatically. The wording comes from System settings → Message templates (or the built-in text).
        Viewing this list and opening a chat are recorded in the audit log.
      </p>
      <ErrorNote message={error} />
      {rows.length === 0 && <p className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">Nobody needs a reminder right now.</p>}
      <ul className="space-y-3">
        {rows.map((r) => {
          const l: Lang = lang[r.tenant_id] ?? (r.language === 'en' ? 'en' : 'fr')
          const b = build(r, l)
          return (
            <li key={r.tenant_id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{r.business}</div>
                  <div className="text-sm text-slate-600">{r.owner_name ?? '—'} · {r.owner_phone ?? 'no phone'} · {r.plan_code}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <Badge value={r.state} /> ends {fmtDate(r.period_end)} ({b.days >= 0 ? `${b.days} days left` : `${-b.days} days ago`}) · {KIND_LABEL[b.kind]}
                    {r.last_reminder && <span>· last reminder {fmtDate(r.last_reminder)}</span>}
                  </div>
                </div>
                <select aria-label="Message language" className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={l} onChange={(e) => setLang({ ...lang, [r.tenant_id]: e.target.value as Lang })}>
                  <option value="fr">Français</option><option value="en">English</option>
                </select>
              </div>
              <p className="mt-2 whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-sm text-slate-700">{b.text}</p>
              <div className="mt-2">
                {b.link ? (
                  <a
                    href={b.link} target="_blank" rel="noopener noreferrer"
                    onClick={() => { setError(null); api.noteReminder(r.tenant_id, b.kind).then(data.reload, (e: unknown) => setError(e instanceof Error ? e.message : 'Failed')) }}
                    className="inline-block rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                  >
                    Open WhatsApp
                  </a>
                ) : <span className="text-sm text-amber-700">No usable phone number on file.</span>}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
