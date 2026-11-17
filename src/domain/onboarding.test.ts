import { describe, expect, it } from 'vitest'
import {
  categoryProfiles,
  businessCategories,
  normalizeCameroonPhone,
  toOnboardingPayload,
  validateOnboarding,
  type OnboardingInput,
} from './onboarding'

const valid: OnboardingInput = {
  businessName: 'Boutique Mama Ngono',
  category: 'general_store',
  town: 'Douala',
  ownerName: 'Ngono Marie',
  ownerPhone: '677 12 34 56',
  language: 'fr',
  employeeCount: 2,
  oversellPolicy: 'allow_and_flag',
}

describe('Cameroon phone numbers', () => {
  it.each([
    ['677123456', '+237677123456'],
    ['+237 677 12 34 56', '+237677123456'],
    ['237-699-00-11-22', '+237699001122'],
    ['00237655443322', '+237655443322'],
  ])('normalizes %s', (raw, expected) => {
    expect(normalizeCameroonPhone(raw)).toBe(expected)
  })
  it.each(['12345', '+33612345678', '577123456', ''])('rejects %s', (raw) => {
    expect(normalizeCameroonPhone(raw)).toBeNull()
  })
})

describe('onboarding validation', () => {
  it('accepts a complete simple-store setup', () => {
    expect(validateOnboarding(valid)).toEqual({})
  })
  it('reports each missing field', () => {
    const errors = validateOnboarding({ ...valid, businessName: '', town: '', ownerPhone: '1' })
    expect(Object.keys(errors).sort()).toEqual(['businessName', 'ownerPhone', 'town'])
  })
  it('builds a database payload with a normalized phone', () => {
    const p = toOnboardingPayload(valid)
    expect(p.owner_phone).toBe('+237677123456')
    expect(p.tax_id).toBeNull()
  })
})

describe('category profiles', () => {
  it('every category has a profile with at least one unit', () => {
    for (const c of businessCategories) expect(categoryProfiles[c].suggestedUnits.length).toBeGreaterThan(0)
  })
  it('pharmacies suggest batch and expiry tracking; clothing suggests variants', () => {
    expect(categoryProfiles.pharmacy.trackExpiry).toBe(true)
    expect(categoryProfiles.pharmacy.trackBatches).toBe(true)
    expect(categoryProfiles.clothing.trackVariants).toBe(true)
  })
})
