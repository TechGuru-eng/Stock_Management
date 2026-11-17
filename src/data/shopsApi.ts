import { supabase } from '../lib/supabase'

/** Shop management happens on the server (it needs a connection): shops are shared set-up, not daily transactions. */
export class ShopApiError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ShopApiError'
    this.code = code
  }
}

function fail(error: { code?: string; message: string }): never {
  if (error.code === 'SB403' || /plan_limit/.test(error.message)) throw new ShopApiError('plan_limit', error.message)
  if (error.code === '42501') throw new ShopApiError('not_allowed', error.message)
  if (/at least one active shop/.test(error.message)) throw new ShopApiError('last_shop', error.message)
  throw new ShopApiError('server', error.message)
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (!supabase || !navigator.onLine) throw new ShopApiError('offline', 'offline')
  const { data, error } = await supabase.rpc(fn, args)
  if (error) fail(error)
  return data as T
}

export const createShop = (tenantId: string, name: string, town: string) => call<string>('create_shop', { p_tenant: tenantId, p_name: name, p_town: town })
export const updateShop = (shopId: string, name: string, town: string, active: boolean) => call<void>('update_shop', { p_shop: shopId, p_name: name, p_town: town, p_active: active })
export const setMemberShops = (membershipId: string, shopIds: string[]) => call<void>('set_member_shops', { p_membership: membershipId, p_shops: shopIds })
