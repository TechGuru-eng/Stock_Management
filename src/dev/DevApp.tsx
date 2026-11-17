import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { AuthContext, type AuthState } from '../auth/AuthProvider'
import { LockScreen } from '../auth/LockScreen'
import { enrollLocalPin } from '../auth/localPin'
import { Shell } from '../App'

/**
 * DEV ONLY (never imported in production): a fake signed-in user for UI testing.
 *   ?dev=1            owner
 *   ?dev=1&lock=1     a cashier whose device is locked; the PIN is 4821
 */
const base: Omit<AuthState, 'membership'> = {
  loading: false,
  session: { user: { id: 'dev-user', phone: '' } } as unknown as Session,
  refreshMembership: async () => {},
  signOut: async () => {},
}

export function DevApp() {
  const lock = new URLSearchParams(location.search).has('lock')
  const [locked, setLocked] = useState(lock)
  const [ready, setReady] = useState(!lock)

  useEffect(() => {
    if (lock) void enrollLocalPin('dev-user', '4821', 'Awa (test)').then(() => setReady(true))
  }, [lock])

  const dev: AuthState = {
    ...base,
    membership: {
      tenantId: 'dev-tenant', tenantName: 'Boutique Test', role: lock ? 'cashier' : 'owner', language: 'fr',
      shopId: 'dev-shop', oversellPolicy: 'allow_and_flag',
    },
  }
  if (!ready) return <></>
  return (
    <AuthContext.Provider value={dev}>
      {locked ? <LockScreen onUnlocked={() => setLocked(false)} /> : <Shell autoSync={false} />}
    </AuthContext.Provider>
  )
}
