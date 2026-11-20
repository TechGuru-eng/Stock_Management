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
    <section className="panel" style={{ marginTop: 24 }}>
      <h3 className="h6">{t('billing.supportLog.title')}</h3>
      <p className="body-sm muted" style={{ marginBottom: 8 }}>{t('billing.supportLog.hint')}</p>
      {rows.length === 0 ? <p className="body-sm">{t('billing.supportLog.none')}</p> : (
        <ul className="body-sm stack" style={{ gap: 4 }}>
          {rows.map((g) => <li key={g.id}><span className="num">{new Date(g.created_at).toLocaleString()}</span> — {g.reason}</li>)}
        </ul>
      )}
    </section>
  )
}
