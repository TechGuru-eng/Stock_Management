import { describe, expect, it } from 'vitest'
import { canAddShop, checkTransfer, pickShop } from './shops'

const shops = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]

describe('choosing a shop', () => {
  it('reopens the last shop, or falls back to the first', () => {
    expect(pickShop(shops, 'b')).toBe('b')
    expect(pickShop(shops, 'gone')).toBe('a') // no longer allowed or deactivated
    expect(pickShop(shops, null)).toBe('a')
    expect(pickShop([], 'a')).toBeNull()
  })
})

describe('plan limit for shops', () => {
  it('allows another shop only below the limit', () => {
    expect(canAddShop(1, 1)).toBe(false)
    expect(canAddShop(3, 2)).toBe(true)
    expect(canAddShop(null, 99)).toBe(true)
  })
})

describe('checking a transfer', () => {
  const have = new Map([['p1', 10], ['p2', 0]])
  it('accepts a normal transfer, including all the stock', () => {
    expect(checkTransfer('a', 'b', [{ productId: 'p1', qty: 10 }], have)).toEqual({ ok: true })
  })
  it('refuses everything that would invent or lose stock', () => {
    expect(checkTransfer('a', 'a', [{ productId: 'p1', qty: 1 }], have)).toMatchObject({ problem: 'same_shop' })
    expect(checkTransfer('a', 'b', [], have)).toMatchObject({ problem: 'no_lines' })
    expect(checkTransfer('a', 'b', [{ productId: 'p1', qty: 0 }], have)).toMatchObject({ problem: 'bad_quantity' })
    expect(checkTransfer('a', 'b', [{ productId: 'p1', qty: 1.5 }], have)).toMatchObject({ problem: 'bad_quantity' })
    expect(checkTransfer('a', 'b', [{ productId: 'p1', qty: 11 }], have)).toMatchObject({ problem: 'not_enough_stock', productId: 'p1' })
    expect(checkTransfer('a', 'b', [{ productId: 'p2', qty: 1 }], have)).toMatchObject({ problem: 'not_enough_stock' })
    expect(checkTransfer('a', 'b', [{ productId: 'p1', qty: 1 }, { productId: 'p1', qty: 2 }], have)).toMatchObject({ problem: 'duplicate_product' })
    expect(checkTransfer('a', 'b', [{ productId: 'zzz', qty: 1 }], have)).toMatchObject({ problem: 'not_enough_stock' })
  })
})
