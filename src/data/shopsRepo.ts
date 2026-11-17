import { newId, db, deviceId, type MovementRec } from './db'
import { can } from '../domain/permissions'
import { issue, receive } from '../domain/costing'
import { checkTransfer, type TransferLineInput } from '../domain/shops'
import { loadCost, queue, saveCost, type Ctx } from './repo'

/**
 * Move stock from the current shop (ctx.shopId) to another shop of the same business.
 * Two ledger rows per product, sharing one reference: out of here at its average cost, into there at that same value, so
 * no value appears or disappears. All rows go up in ONE sync group, so either the whole transfer arrives or none of it.
 */
export async function transferStock(ctx: Ctx, toShopId: string, lines: TransferLineInput[], note?: string): Promise<string> {
  if (!can(ctx.role, 'stock.adjust_approve')) throw new Error('not allowed to transfer stock')
  const transferId = newId()

  await db.transaction('rw', [db.movements, db.costs, db.outbox], async () => {
    const available = new Map<string, number>()
    for (const l of lines) available.set(l.productId, (await loadCost(ctx.shopId, l.productId)).quantity)
    const check = checkTransfer(ctx.shopId, toShopId, lines, available)
    if (!check.ok) throw new Error(`transfer refused: ${check.problem}`)

    const at = new Date().toISOString()
    for (const l of lines) {
      const out = issue(await loadCost(ctx.shopId, l.productId), l.qty)
      await saveCost(ctx.shopId, l.productId, out.state)
      const base = { tenantId: ctx.tenantId, productId: l.productId, staffId: ctx.userId, deviceId: deviceId(), createdAt: at, referenceId: transferId, reason: note?.trim() || undefined }
      const mOut: MovementRec = { ...base, id: newId(), shopId: ctx.shopId, quantity: -l.qty, type: 'transfer_out', unitCost: Math.round(out.cogs / l.qty), totalCost: out.cogs }
      const mIn: MovementRec = { ...base, id: newId(), shopId: toShopId, quantity: l.qty, type: 'transfer_in', unitCost: Math.round(out.cogs / l.qty), totalCost: out.cogs }
      await saveCost(toShopId, l.productId, receive(await loadCost(toShopId, l.productId), l.qty, out.cogs))
      await db.movements.add(mOut)
      await db.movements.add(mIn)
      await queue('stock_movements', mOut, transferId)
      await queue('stock_movements', mIn, transferId)
    }
  })
  return transferId
}
