import { useState } from 'react'
import { formatXaf } from './domain/money'

type Tab = 'home' | 'sales' | 'stock' | 'money' | 'more'

const tabs: { id: Tab; label: string }[] = [
  { id: 'home', label: 'Accueil / Home' },
  { id: 'sales', label: 'Ventes / Sales' },
  { id: 'stock', label: 'Stock' },
  { id: 'money', label: 'Argent / Money' },
  { id: 'more', label: 'Plus / More' },
]

/**
 * App shell only (Phase 1). Each module screen is built in its own phase;
 * until then a tab says so plainly instead of showing fake data.
 */
export default function App() {
  const [tab, setTab] = useState<Tab>('home')
  const online = typeof navigator !== 'undefined' ? navigator.onLine : true

  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center justify-between bg-teal-700 px-4 py-3 text-white">
        <h1 className="text-lg font-semibold">StockCM</h1>
        <span className="text-sm" aria-live="polite">
          {online ? 'En ligne / Online' : 'Hors ligne / Offline'}
        </span>
      </header>

      <main className="flex-1 p-4">
        <h2 className="mb-2 text-xl font-semibold">
          {tabs.find((t) => t.id === tab)?.label}
        </h2>
        <p className="text-slate-600 dark:text-slate-300">
          Module not built yet. Money is shown as {formatXaf(30000)}.
        </p>
      </main>

      <nav className="grid grid-cols-5 border-t border-slate-200 dark:border-slate-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`min-h-14 px-1 text-xs ${
              tab === t.id ? 'font-semibold text-teal-700' : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
