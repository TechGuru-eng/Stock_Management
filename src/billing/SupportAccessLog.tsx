import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'

interface Grant { id: string; reason: string; created_at: string; ended_at: string | null }

/** Shows the owner every time StockCM support looked at their account, and why. (Needs a connection.) */
export function SupportAccessLog() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Grant[] | null>(null)
  useEffect(() => {
    if (!supabase || !navigator.onLine) return
    void supabase.from('support_grants').select('id, reason, created_at, ended_at').order('created_at', { ascending: false }).limit(10)
      .then(({ data }) => setRows((data as Grant[] | null) ?? []))
  }, [])
  if (!rows) return null
  return (
    <section className="mt-6 rounded border border-slate-200 p-3 dark:border-slate-700">
      <h3 className="font-semibold">{t('billing.supportLog.title')}</h3>
      <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">{t('billing.supportLog.hint')}</p>
      {rows.length === 0 ? <p className="text-sm">{t('billing.supportLog.none')}</p> : (
        <ul className="space-y-1 text-sm">
          {rows.map((g) => <li key={g.id}><span className="tabular-nums">{new Date(g.created_at).toLocaleString()}</span> — {g.reason}</li>)}
        </ul>
      )}
    </section>
  )
}
