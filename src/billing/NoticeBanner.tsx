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
      {maintenance && <div role="status" className="banner banner--flag">! {maintenance}</div>}
      {announcement && (
        <div role="status" className={n.announcement?.level === 'warn' ? 'banner banner--flag' : 'banner'}>{n.announcement?.level === 'warn' ? `! ${announcement}` : announcement}</div>
      )}
    </>
  )
}
