import { useTranslation } from 'react-i18next'
import { noticeText, useNotices } from './notices'

/** Announcements and maintenance notices written by StockCM staff. They inform only: they never block selling. */
export function NoticeBanner() {
  const { i18n } = useTranslation()
  const n = useNotices()
  const maintenance = noticeText(n.maintenance, i18n.language)
  const announcement = noticeText(n.announcement, i18n.language)
  if (!maintenance && !announcement) return null
  return (
    <>
      {maintenance && <div role="status" className="bg-amber-100 px-4 py-2 text-sm text-amber-900">{maintenance}</div>}
      {announcement && (
        <div role="status" className={`px-4 py-2 text-sm ${n.announcement?.level === 'warn' ? 'bg-amber-100 text-amber-900' : 'bg-sky-100 text-sky-900'}`}>{announcement}</div>
      )}
    </>
  )
}
