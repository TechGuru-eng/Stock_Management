import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { db } from '../../data/db'
import type { Party } from '../../domain/invoice'
import { supabase } from '../../lib/supabase'

interface Info { taxId?: string; address?: string; town?: string; phone?: string; ownerName?: string }
const KEY = 'businessInfo'

/**
 * The business details printed on invoices (tax number, address, phone). Fetched when online and kept on the device, so an
 * invoice can be produced with no connection. Missing details are simply left off the invoice.
 */
export function useBusinessInfo(): Info {
  const { membership } = useAuth()
  const tenantId = membership?.tenantId
  const rec = useLiveQuery(() => db.meta.get(KEY), [])
  useEffect(() => {
    if (!supabase || !tenantId || !navigator.onLine) return
    void (async () => {
      const [t, p] = await Promise.all([
        supabase!.from('tenants').select('tax_id').eq('id', tenantId).maybeSingle(),
        supabase!.from('business_profiles').select('address, town, owner_phone, owner_name').eq('tenant_id', tenantId).maybeSingle(),
      ])
      const info: Info = {
        taxId: (t.data?.tax_id as string | null) ?? undefined, address: (p.data?.address as string | null) ?? undefined, town: (p.data?.town as string | null) ?? undefined,
        phone: (p.data?.owner_phone as string | null) ?? undefined, ownerName: (p.data?.owner_name as string | null) ?? undefined,
      }
      await db.meta.put({ key: KEY, value: info })
    })()
  }, [tenantId])
  return (rec?.value as Info | undefined) ?? {}
}

/** The issuer shown on a sale invoice: the business, with the current shop's town and address. */
export function useSeller(): Party {
  const { membership } = useAuth()
  const info = useBusinessInfo()
  const shop = membership?.shops.find((s) => s.id === membership.shopId)
  const multi = (membership?.shops.length ?? 0) > 1
  const lines = [multi && shop ? shop.name : '', info.address ?? '', multi ? (shop?.town ?? info.town ?? '') : (info.town ?? '')].filter(Boolean)
  return { name: membership?.tenantName ?? 'StockCM', lines, phone: info.phone, taxId: info.taxId }
}

/** The business as the BUYER on a StockCM subscription invoice. */
export function useBuyer(): Party {
  const { membership } = useAuth()
  const info = useBusinessInfo()
  return { name: membership?.tenantName ?? '', lines: [info.ownerName ?? '', info.address ?? '', info.town ?? ''].filter(Boolean), phone: info.phone, taxId: info.taxId }
}
