import { useMemo } from 'react'
import { useAuth } from '../auth/AuthProvider'
import type { Ctx } from './repo'

/** Who is acting, in which shop. Null until the user has signed in and has a business. */
export function useCtx(): Ctx | null {
  const { session, membership, actingUserId } = useAuth()
  return useMemo(
    () =>
      session && membership
        ? {
            tenantId: membership.tenantId,
            shopId: membership.shopId,
            userId: actingUserId,
            role: membership.role,
            oversellPolicy: membership.oversellPolicy,
          }
        : null,
    [session, membership, actingUserId],
  )
}
