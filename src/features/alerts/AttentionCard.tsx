import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertsView } from './AlertsView'
import { useAlerts } from './useAlerts'

/** Home: the products that need attention, at a glance. Hidden for people who do not look after stock, and when all is well. */
export function AttentionCard({ goOrder }: { goOrder: () => void }) {
  const { t } = useTranslation()
  const state = useAlerts()
  const [open, setOpen] = useState(false)
  if (!state || state.active.length === 0) return null
  const c = state.counts
  return (
    <section className="rounded border border-amber-400 bg-amber-50 p-3 text-amber-950 dark:bg-amber-950 dark:text-amber-50">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{t('alerts.title')}</h3>
        <button onClick={() => setOpen((x) => !x)} aria-expanded={open} className="min-h-10 rounded border border-current px-3 text-sm">{open ? t('alerts.hide') : t('alerts.seeAll')}</button>
      </div>
      <p className="mt-1 text-sm">
        {c.out > 0 && <strong className="mr-2 text-red-700 dark:text-red-300">{t('alerts.nOut', { count: c.out })}</strong>}
        {c.low > 0 && <span className="mr-2">{t('alerts.nLow', { count: c.low })}</span>}
        {c.running_out > 0 && <span>{t('alerts.nRunning', { count: c.running_out })}</span>}
      </p>
      {!open && <p className="mt-1 text-sm">{state.active.slice(0, 4).map((a) => a.name).join(', ')}{state.active.length > 4 ? '…' : ''}</p>}
      {open && <div className="mt-3 text-slate-900 dark:text-slate-100"><AlertsView onOrder={goOrder} /></div>}
    </section>
  )
}
