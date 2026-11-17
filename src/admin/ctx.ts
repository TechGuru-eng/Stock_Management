import { createContext, useContext } from 'react'
import type { AdminApi } from './api'
import type { AdminRole } from './permissions'

export interface AdminCtx { api: AdminApi; role: AdminRole }
export const AdminContext = createContext<AdminCtx | null>(null)

export function useAdmin(): AdminCtx {
  const c = useContext(AdminContext)
  if (!c) throw new Error('outside the admin app')
  return c
}
