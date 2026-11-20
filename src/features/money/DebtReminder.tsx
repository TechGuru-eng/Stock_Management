import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { db } from '../../data/db'
import { DEBT_TEMPLATE, firstName, moneyText, renderTemplate, waLink, type Lang } from '../../domain/reminders'

const KEY = 'debtRemindersSent'

/** When each customer was last reminded, kept on this device so the owner does not nag the same person twice in a day. */
export function useLastReminders(): Record<string, string> {
  return (useLiveQuery(async () => (await db.meta.get(KEY))?.value as Record<string, string> | undefined, []) ?? {})
}

async function noteReminder(customerId: string) {
  const cur = ((await db.meta.get(KEY))?.value as Record<string, string> | undefined) ?? {}
  await db.meta.put({ key: KEY, value: { ...cur, [customerId]: new Date().toISOString() } })
}

function useMessage(name: string, balance: number) {
  const { i18n } = useTranslation()
  const { membership } = useAuth()
  const lang: Lang = i18n.language.startsWith('fr') ? 'fr' : 'en'
  return renderTemplate(DEBT_TEMPLATE[lang], { name: firstName(name), shop: membership?.tenantName ?? '', amount: moneyText(balance) })
}

export function ago(iso: string | undefined, lang: string): string | null {
  if (!iso) return null
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  return days <= 0 ? (lang.startsWith('fr') ? "aujourd'hui" : 'today') : lang.startsWith('fr') ? `il y a ${days} j` : `${days} d ago`
}

/** Opens WhatsApp with the default message typed in. The person presses Send. */
export function QuickReminder({ customer, balance }: { customer: { id: string; name: string; phone?: string }; balance: number }) {
  const { t, i18n } = useTranslation()
  const last = useLastReminders()[customer.id]
  const text = useMessage(customer.name, balance)
  const link = waLink(customer.phone, text)
  if (balance <= 0) return null
  if (!link) return <span className="label-lg muted">{t('reminders.noPhone')}</span>
  return (
    <span className="flex flex-col items-end" style={{ gap: 4 }}>
      <a
        href={link} target="_blank" rel="noopener noreferrer" onClick={() => void noteReminder(customer.id)}
        className="btn btn--secondary btn--sm"
      >
        {t('reminders.whatsapp')}
      </a>
      {last && <span className="label-lg muted">{t('reminders.last', { when: ago(last, i18n.language) })}</span>}
    </span>
  )
}

/** The editable version, for the customer's own page. */
export function DebtReminder({ customer, balance }: { customer: { id: string; name: string; phone?: string }; balance: number }) {
  const { t, i18n } = useTranslation()
  const last = useLastReminders()[customer.id]
  const base = useMessage(customer.name, balance)
  const [text, setText] = useState(base)
  useEffect(() => setText(base), [base])
  if (balance <= 0) return null
  const link = waLink(customer.phone, text)
  return (
    <section className="panel stack">
      <h4 className="h6">{t('reminders.title')}</h4>
      {!customer.phone || !link ? <p className="body-md muted">{t('reminders.noPhoneLong')}</p> : (
        <>
          <textarea aria-label={t('reminders.message')} rows={4} value={text} onChange={(e) => setText(e.target.value)} className="input" />
          <a
            href={link} target="_blank" rel="noopener noreferrer" onClick={() => void noteReminder(customer.id)}
            className="btn btn--primary"
          >
            {t('reminders.open')}
          </a>
          <p className="body-sm muted">{t('reminders.hint')}{last && ` ${t('reminders.last', { when: ago(last, i18n.language) })}`}</p>
        </>
      )}
    </section>
  )
}
