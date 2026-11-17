import { useCallback, useEffect, useRef, useState } from 'react'
import type { AdminApi, Whoami } from './api'
import { AdminContext } from './ctx'
import { Login } from './Login'
import { pagesFor, type AdminPage } from './permissions'
import { Audit } from './pages/Audit'
import { Businesses } from './pages/Businesses'
import { Overview } from './pages/Overview'
import { Payments } from './pages/Payments'
import { Plans } from './pages/Plans'
import { Reminders } from './pages/Reminders'
import { SettingsPage } from './pages/Settings'
import { Button } from './ui'

const IDLE_MS = 15 * 60_000
const TITLES: Record<AdminPage, string> = { overview: 'Overview', businesses: 'Businesses', payments: 'Payments', reminders: 'Renewal reminders', plans: 'Plans & prices', audit: 'Audit log', settings: 'System settings' }

type Phase = 'boot' | 'credentials' | 'code' | 'ready'

export function AdminApp({ api }: { api: AdminApi }) {
  const [phase, setPhase] = useState<Phase>('boot')
  const [me, setMe] = useState<Whoami | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [page, setPage] = useState<AdminPage>('overview')

  const check = useCallback(async () => {
    if (!(await api.auth.hasSession())) { setPhase('credentials'); return }
    const w = await api.auth.whoami()
    if (!w) {
      await api.auth.signOut()
      setNotice('This account is not a platform administrator.')
      setPhase('credentials')
      return
    }
    setMe(w)
    setPhase(w.aal === 'aal2' ? 'ready' : 'code')
  }, [api])

  useEffect(() => { void check() }, [check])

  const signOut = useCallback(async () => {
    await api.auth.signOut()
    setMe(null); setPhase('credentials')
  }, [api])

  // Signs out after 15 minutes without any activity.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (phase !== 'ready') return
    const reset = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => { setNotice('Signed out after 15 minutes of inactivity.'); void signOut() }, IDLE_MS)
    }
    const evs = ['pointerdown', 'keydown', 'scroll'] as const
    evs.forEach((e) => window.addEventListener(e, reset))
    reset()
    return () => { evs.forEach((e) => window.removeEventListener(e, reset)); if (timer.current) clearTimeout(timer.current) }
  }, [phase, signOut])

  if (phase === 'boot') return <p className="p-8 text-center text-sm text-slate-500">Loading…</p>

  if (phase === 'credentials' || phase === 'code') {
    return (
      <>
        {notice && <p role="status" className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">{notice}</p>}
        <Login api={api} step={phase} onDone={() => { setNotice(null); void check() }} />
      </>
    )
  }

  const role = me!.role
  const pages = pagesFor(role)
  const current: AdminPage = pages.includes(page) ? page : pages[0]

  return (
    <AdminContext.Provider value={{ api, role }}>
      <div className="min-h-dvh bg-slate-50 text-slate-900 md:flex">
        <nav className="border-b border-slate-200 bg-white md:w-56 md:shrink-0 md:border-b-0 md:border-r" aria-label="Sections">
          <div className="flex items-center justify-between px-4 py-3 md:block">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-teal-700">StockCM</div>
              <div className="text-sm font-semibold">Administration</div>
            </div>
            <div className="text-right md:mt-3 md:text-left">
              <div className="inline-block rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{role}</div>
              <button className="ml-2 text-xs text-slate-500 underline md:ml-0 md:mt-1 md:block" onClick={() => void signOut()}>Sign out</button>
            </div>
          </div>
          <ul className="flex gap-1 overflow-x-auto px-2 pb-2 md:block md:space-y-1 md:px-3">
            {pages.map((p) => (
              <li key={p}>
                <button
                  onClick={() => setPage(p)}
                  aria-current={p === current ? 'page' : undefined}
                  className={`w-full whitespace-nowrap rounded-md px-3 py-2 text-left text-sm font-medium ${p === current ? 'bg-teal-50 text-teal-800' : 'text-slate-700 hover:bg-slate-100'}`}
                >
                  {TITLES[p]}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-w-0 flex-1 p-4 md:p-6">
          <h1 className="mb-4 text-xl font-semibold">{TITLES[current]}</h1>
          {current === 'overview' && <Overview />}
          {current === 'businesses' && <Businesses />}
          {current === 'payments' && <Payments />}
          {current === 'reminders' && <Reminders />}
          {current === 'plans' && <Plans />}
          {current === 'audit' && <Audit />}
          {current === 'settings' && <SettingsPage />}
          <div className="mt-8"><Button kind="secondary" onClick={() => void signOut()}>Sign out</Button></div>
        </main>
      </div>
    </AdminContext.Provider>
  )
}
