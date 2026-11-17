import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { db } from '../data/db'
import { subscriptionState, type SubscriptionState } from '../domain/subscription'
import type { LicenceStatus } from '../domain/licence'
import { applyGuard, type LicenceView } from './licenceStore'

export interface SubscriptionView {
  view: LicenceView | null
  state: SubscriptionState | null
  status: LicenceStatus | null
}

/** The subscription as THIS device sees it, from the signed licence (so it works offline). Re-checked every minute. */
export function useSubscription(): SubscriptionView {
  const token = useLiveQuery(() => db.meta.get('licence'), [])
  const [view, setView] = useState<LicenceView | null>(null)

  useEffect(() => {
    let alive = true
    const run = () => void applyGuard().then((v) => alive && setView(v))
    run()
    const timer = setInterval(run, 60_000)
    return () => { alive = false; clearInterval(timer) }
  }, [token])

  const state = view
    ? subscriptionState(
        { kind: view.payload.base === 'trial' ? 'trial' : 'active', periodEnd: new Date(view.payload.periodEnd).toISOString(), suspended: view.payload.base === 'suspended' },
        Date.now(),
        Math.round((view.payload.graceEnd - view.payload.periodEnd) / 86_400_000),
      )
    : null
  return { view, state, status: view?.status ?? null }
}
