import type { Session } from '@supabase/supabase-js'
import { AuthContext, type AuthState } from '../auth/AuthProvider'
import { Shell } from '../App'

/** DEV ONLY (never imported in production): a fake signed-in owner for UI testing. */
const dev: AuthState = {
  loading: false,
  session: { user: { id: 'dev-user', phone: '' } } as unknown as Session,
  membership: {
    tenantId: 'dev-tenant', tenantName: 'Boutique Test', role: 'owner', language: 'fr',
    shopId: 'dev-shop', oversellPolicy: 'allow_and_flag',
  },
  refreshMembership: async () => {},
  signOut: async () => {},
}

export function DevApp() {
  return (
    <AuthContext.Provider value={dev}>
      <Shell autoSync={false} />
    </AuthContext.Provider>
  )
}
