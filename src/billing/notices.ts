import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect } from 'react'
import { db } from '../data/db'
import { supabase } from '../lib/supabase'

export interface Notice { active: boolean; level?: 'info' | 'warn'; fr?: string; en?: string }
export interface Notices { announcement: Notice | null; maintenance: Notice | null; flags: Record<string, boolean> }

const EMPTY: Notices = { announcement: null, maintenance: null, flags: {} }
const KEY = 'platformNotices'

/** Defensive: whatever the server sends, only these shapes ever reach the screen. */
export function parseNotices(raw: unknown): Notices {
  if (!raw || typeof raw !== 'object') return EMPTY
  const r = raw as Record<string, unknown>
  const notice = (v: unknown): Notice | null => {
    if (!v || typeof v !== 'object') return null
    const o = v as Record<string, unknown>
    return {
      active: o.active === true, level: o.level === 'warn' ? 'warn' : 'info',
      fr: typeof o.fr === 'string' ? o.fr.slice(0, 300) : '', en: typeof o.en === 'string' ? o.en.slice(0, 300) : '',
    }
  }
  const flags: Record<string, boolean> = {}
  if (r.flags && typeof r.flags === 'object') for (const [k, v] of Object.entries(r.flags as Record<string, unknown>)) if (typeof v === 'boolean') flags[k] = v
  return { announcement: notice(r.announcement), maintenance: notice(r.maintenance), flags }
}

/** The text to show in a language: that language if written, otherwise the other one. Nothing if the notice is off. */
export function noticeText(n: Notice | null | undefined, lang: string): string | null {
  if (!n || !n.active) return null
  const first = lang.startsWith('fr') ? n.fr : n.en
  const text = (first || n.fr || n.en || '').trim()
  return text || null
}

/** Fetch the latest notices and keep them for offline use. Silent when offline. */
export async function refreshNotices(): Promise<void> {
  if (!supabase) return
  const { data, error } = await supabase.rpc('public_notices')
  if (error) return
  await db.meta.put({ key: KEY, value: parseNotices(data) })
}

export function useNotices(): Notices {
  const rec = useLiveQuery(() => db.meta.get(KEY), [])
  useEffect(() => {
    if (navigator.onLine) void refreshNotices()
    const again = () => void refreshNotices()
    window.addEventListener('online', again)
    const timer = setInterval(again, 30 * 60_000)
    return () => { window.removeEventListener('online', again); clearInterval(timer) }
  }, [])
  return (rec?.value as Notices | undefined) ?? EMPTY
}

/** A feature switched on or off by the platform (default: on, so a missing flag never removes a feature). */
export function useFlag(name: string): boolean {
  return useNotices().flags[name] ?? true
}
