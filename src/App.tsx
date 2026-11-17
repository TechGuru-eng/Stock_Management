import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AuthProvider, useAuth } from './auth/AuthProvider'
import { LoginScreen } from './auth/LoginScreen'
import { OnboardingWizard } from './onboarding/OnboardingWizard'
import { isSupabaseConfigured } from './lib/supabase'
import { PosScreen } from './features/pos/PosScreen'
import { StockScreen } from './features/stock/StockScreen'
import { SyncBadge } from './features/sync/SyncBadge'
import { SyncScreen } from './features/sync/SyncScreen'
import { startAutoSync } from './sync/auto'
import { supabaseTransport } from './sync/supabaseTransport'

type Tab = 'home' | 'sales' | 'stock' | 'money' | 'more'
const tabs: Tab[] = ['home', 'sales', 'stock', 'money', 'more']

/** App shell. Module screens arrive in later phases; a tab says so plainly instead of faking data. */
export function Shell({ autoSync = true }: { autoSync?: boolean }) {
  const { t } = useTranslation()
  const { membership, signOut } = useAuth()
  const [tab, setTab] = useState<Tab>('home')
  const online = navigator.onLine

  useEffect(() => {
    if (!autoSync || !membership) return
    return startAutoSync(supabaseTransport, { tenantId: membership.tenantId, deviceName: navigator.platform || 'web' })
  }, [autoSync, membership])

  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center justify-between bg-teal-700 px-4 py-3 text-white">
        <h1 className="text-lg font-semibold">{membership?.tenantName ?? 'StockCM'}</h1>
        <span className="flex items-center gap-3 text-sm">
          <SyncBadge onClick={() => setTab('more')} />
          <span aria-live="polite">{online ? t('app.online') : t('app.offline')}</span>
        </span>
      </header>
      <main className="flex-1 p-4">
        <h2 className="mb-2 text-xl font-semibold">{t(`nav.${tab}`)}</h2>
        {tab === 'sales' && <PosScreen />}
        {tab === 'stock' && <StockScreen />}
        {tab === 'more' && <SyncScreen canSync={autoSync} />}
        {(tab === 'home' || tab === 'money') && (
          <p className="text-slate-600 dark:text-slate-300">{t('app.notBuilt')}</p>
        )}
        {tab === 'more' && (
          <button onClick={() => void signOut()} className="mt-4 min-h-12 rounded border border-slate-300 px-4">
            {t('auth.signOut')}
          </button>
        )}
      </main>
      <nav className="grid grid-cols-5 border-t border-slate-200 dark:border-slate-800">
        {tabs.map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            className={`min-h-14 px-1 text-xs ${tab === id ? 'font-semibold text-teal-700' : 'text-slate-600 dark:text-slate-300'}`}
          >
            {t(`nav.${id}`)}
          </button>
        ))}
      </nav>
    </div>
  )
}

function Gate() {
  const { t } = useTranslation()
  const { loading, session, membership } = useAuth()
  if (loading) return <p className="p-6">{t('app.loading')}</p>
  if (!session) return <LoginScreen />
  if (!membership) return <OnboardingWizard />
  return <Shell />
}

export default function App() {
  const { t } = useTranslation()
  if (!isSupabaseConfigured) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="text-2xl font-semibold">{t('config.title')}</h1>
        <p className="mt-2">{t('config.body')}</p>
      </main>
    )
  }
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
