import { useCallback, useEffect, useRef, useState } from 'react'
import '../marketing/editorial/styles.css'
import { useEditorialFonts } from '../marketing/editorial/fonts'
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
import { SyncIssues } from './pages/SyncIssues'
import { Button } from './ui'

const IDLE_MS = 15 * 60_000
const TITLES: Record<AdminPage, string> = {
  overview: 'Overview', businesses: 'Businesses', payments: 'Payments', reminders: 'Renewal reminders', plans: 'Plans & prices',
  syncIssues: 'Sync issues', audit: 'Audit log', settings: 'System settings',
}

type Phase = 'boot' | 'credentials' | 'code' | 'ready'

export function AdminApp({ api }: { api: AdminApi }) {
  useEditorialFonts()
  const [phase, setPhase] = useState<Phase>('boot')
  const [me, setMe] = useState<Whoami | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [page, setPage] = useState<AdminPage>('overview')
  const [menuOpen, setMenuOpen] = useState(false)

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

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

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

  if (phase === 'boot') return <div className="editorial-taste"><p className="body-md muted" style={{ padding: 32, textAlign: 'center' }}>Loading…</p></div>

  if (phase === 'credentials' || phase === 'code') {
    return (
      <div className="editorial-taste">
        {notice && <p role="status" className="notice notice--amber label-lg" style={{ textAlign: 'center', borderRadius: 0 }}>{notice}</p>}
        <Login api={api} step={phase} onDone={() => { setNotice(null); void check() }} />
      </div>
    )
  }

  const role = me!.role
  const pages = pagesFor(role)
  const current: AdminPage = pages.includes(page) ? page : pages[0]

  return (
    <AdminContext.Provider value={{ api, role }}>
      <div className="editorial-taste app-shell">
        <nav className="app-nav" aria-label="Sections">
          <div className="app-nav__head">
            <div>
              <span className="eyebrow muted">Stockora</span>
              <div className="h6">Administration</div>
              <div className="app-nav__current">{TITLES[current]}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="app-nav__role">{role}</span>
              <button className="app-nav__menu-btn" aria-expanded={menuOpen} aria-controls="app-nav-drawer" onClick={() => setMenuOpen(true)}>Menu</button>
              <button className="app-nav__signout" onClick={() => void signOut()}>Sign out</button>
            </div>
          </div>
          <ul className="app-nav__list">
            {pages.map((p) => (
              <li key={p}>
                <button
                  onClick={() => setPage(p)}
                  aria-current={p === current ? 'page' : undefined}
                  className="app-nav__link"
                >
                  {TITLES[p]}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {menuOpen && (
          <div className="side-panel-overlay" role="dialog" aria-modal="true" aria-label="Sections" id="app-nav-drawer" onClick={() => setMenuOpen(false)}>
            <div className="side-panel" onClick={(e) => e.stopPropagation()}>
              <div className="panel__head">
                <span className="eyebrow muted">Sections</span>
                <Button kind="secondary" onClick={() => setMenuOpen(false)}>Close</Button>
              </div>
              <ul className="app-nav__drawer-list">
                {pages.map((p) => (
                  <li key={p}>
                    <button
                      onClick={() => { setPage(p); setMenuOpen(false) }}
                      aria-current={p === current ? 'page' : undefined}
                      className="app-nav__link"
                    >
                      {TITLES[p]}
                    </button>
                  </li>
                ))}
              </ul>
              <button className="app-nav__signout" onClick={() => void signOut()}>Sign out</button>
            </div>
          </div>
        )}
        <main className="app-main">
          <h1 className="h3 app-main__title">{TITLES[current]}</h1>
          {current === 'overview' && <Overview />}
          {current === 'businesses' && <Businesses />}
          {current === 'payments' && <Payments />}
          {current === 'reminders' && <Reminders />}
          {current === 'plans' && <Plans />}
          {current === 'syncIssues' && <SyncIssues />}
          {current === 'audit' && <Audit />}
          {current === 'settings' && <SettingsPage />}
          <div style={{ marginTop: 32 }}><Button kind="secondary" onClick={() => void signOut()}>Sign out</Button></div>
        </main>
      </div>
    </AdminContext.Provider>
  )
}
