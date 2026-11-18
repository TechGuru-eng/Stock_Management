import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AuthProvider, useAuth } from './auth/AuthProvider'
import { LoginScreen } from './auth/LoginScreen'
import { OnboardingWizard } from './onboarding/OnboardingWizard'
import { isSupabaseConfigured } from './lib/supabase'
import { SalesHub } from './features/pos/SalesHub'
import { StockHub } from './features/stock/StockHub'
import { HomeScreen } from './features/home/HomeScreen'
import { MoneyScreen } from './features/money/MoneyScreen'
import { SyncBadge } from './features/sync/SyncBadge'
import { SyncScreen } from './features/sync/SyncScreen'
import { StaffScreen } from './features/staff/StaffScreen'
import { LockScreen } from './auth/LockScreen'
import { useIdleLock } from './auth/lock'
import { startAutoSync } from './sync/auto'
import { onSyncComplete } from './sync/engine'
import { installWriteGuard } from './data/writeGuard'
import { applyGuard, refreshLicence } from './billing/licenceStore'
import { BillingScreen } from './billing/BillingScreen'
import { AlertSettings } from './features/alerts/AlertSettings'
import { LoyaltySettings } from './features/loyalty/LoyaltySettings'
import { TillProviders } from './features/money/TillProviders'
import { StockAlertBanner } from './features/alerts/StockAlertBanner'
import { useAlertNotifications, useAlerts } from './features/alerts/useAlerts'
import { NoticeBanner } from './billing/NoticeBanner'
import { refreshRoster } from './auth/roster'
import { SwitchPerson } from './auth/SwitchPerson'
import { ShopSwitcher } from './features/shops/ShopSwitcher'
import { ShopsScreen } from './features/shops/ShopsScreen'
import { SubscriptionBanner } from './billing/SubscriptionBanner'
import { SupportAccessLog } from './billing/SupportAccessLog'
import { supabase } from './lib/supabase'

// New records are blocked on a device whose subscription has lapsed (the server enforces the same rule).
installWriteGuard()
import { supabaseTransport } from './sync/supabaseTransport'

type Tab = 'home' | 'sales' | 'stock' | 'money' | 'more'
const tabs: Tab[] = ['home', 'sales', 'stock', 'money', 'more']

/** App shell. Module screens arrive in later phases; a tab says so plainly instead of faking data. */
export function Shell({ autoSync = true }: { autoSync?: boolean }) {
  const { t } = useTranslation()
  const { membership, signOut, session } = useAuth()
  const alerts = useAlerts()
  useAlertNotifications()
  const [tab, setTab] = useState<Tab>('home')
  const [moneySub, setMoneySub] = useState<'summary' | 'debts' | 'expenses' | 'cash'>('summary')
  const online = navigator.onLine

  useEffect(() => {
    if (!autoSync || !membership) return
    return startAutoSync(supabaseTransport, { tenantId: membership.tenantId, deviceName: navigator.platform || 'web' })
  }, [autoSync, membership])

  // A fresh signed licence after every successful sync, and once at start (works offline from the stored one).
  useEffect(() => {
    if (!autoSync || !membership || !supabase) return
    const refresh = async () => {
      const { data } = await supabase!.auth.getSession()
      if (data.session) await refreshLicence(data.session.access_token)
    }
    void applyGuard()
    if (navigator.onLine) void refresh()
    const offRoster = onSyncComplete(async () => { if (session) await refreshRoster(session.user.id) })
    const offLicence = onSyncComplete(refresh)
    return () => { offRoster(); offLicence() }
  }, [autoSync, membership, session])

  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center justify-between bg-teal-700 px-4 py-3 text-white print:hidden">
        <h1 className="text-lg font-semibold">{membership?.tenantName ?? 'StockCM'}</h1>
        <span className="flex items-center gap-3 text-sm">
          <ShopSwitcher />
          <SwitchPerson />
          <SyncBadge onClick={() => setTab('more')} />
          <span aria-live="polite">{online ? t('app.online') : t('app.offline')}</span>
        </span>
      </header>
      <div className="print:hidden">
        <SubscriptionBanner onRenew={() => setTab('more')} />
        <NoticeBanner />
        <StockAlertBanner onSee={() => setTab('home')} />
      </div>
      <main key={membership?.shopId} className="flex-1 p-4">
        <h2 className="mb-2 text-xl font-semibold print:hidden">{t(`nav.${tab}`)}</h2>
        {tab === 'sales' && <SalesHub />}
        {tab === 'stock' && <StockHub />}
        {tab === 'more' && membership?.role === 'owner' && <BillingScreen />}
        {tab === 'more' && <AlertSettings />}
        {tab === 'more' && <LoyaltySettings />}
        {tab === 'more' && <TillProviders />}
        {tab === 'more' && membership?.role === 'owner' && <ShopsScreen />}
        {tab === 'more' && membership?.role === 'owner' && <StaffScreen />}
        {tab === 'more' && membership?.role === 'owner' && <SupportAccessLog />}
        {tab === 'more' && <SyncScreen canSync={autoSync} />}
        {tab === 'home' && (
          <HomeScreen go={(next, sub) => { if (sub) setMoneySub(sub); setTab(next) }} />
        )}
        {tab === 'money' && <MoneyScreen key={moneySub} initial={moneySub} />}
        {tab === 'more' && (
          <button onClick={() => void signOut()} className="mt-4 min-h-12 rounded border border-slate-300 px-4">
            {t('auth.signOut')}
          </button>
        )}
      </main>
      <nav className="grid grid-cols-5 border-t border-slate-200 dark:border-slate-800 print:hidden">
        {tabs.map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            className={`min-h-14 px-1 text-xs ${tab === id ? 'font-semibold text-teal-700' : 'text-slate-600 dark:text-slate-300'}`}
          >
            {t(`nav.${id}`)}
            {id === 'stock' && alerts && alerts.active.length > 0 && (
              <span className={`ml-1 rounded-full px-1.5 text-[10px] font-bold text-white ${alerts.counts.out > 0 ? 'bg-red-600' : 'bg-amber-600'}`} aria-label={t('alerts.badge', { count: alerts.active.length })}>{alerts.active.length}</span>
            )}
          </button>
        ))}
      </nav>
    </div>
  )
}

function Gate() {
  const { t } = useTranslation()
  const { loading, session, membership, signOut } = useAuth()
  // Staff devices lock themselves when idle; the owner (phone login) has no PIN, so nothing to lock.
  const [locked, setLocked] = useIdleLock(Boolean(membership && membership.role !== 'owner'), signOut)
  if (loading) return <p className="p-6">{t('app.loading')}</p>
  if (!session) return <LoginScreen />
  if (!membership) return <OnboardingWizard />
  if (membership.role !== 'owner' && locked) return <LockScreen onUnlocked={() => setLocked(false)} />
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
