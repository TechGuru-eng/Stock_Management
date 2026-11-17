export type BusinessCategory =
  | 'general_store'
  | 'supermarket'
  | 'pharmacy'
  | 'hardware'
  | 'clothing'
  | 'cosmetics'
  | 'wholesale'
  | 'electronics'
  | 'agri_supply'
  | 'other'

export const businessCategories: readonly BusinessCategory[] = [
  'general_store',
  'supermarket',
  'pharmacy',
  'hardware',
  'clothing',
  'cosmetics',
  'wholesale',
  'electronics',
  'agri_supply',
  'other',
]

/**
 * One universal engine, configured per category. The category only SUGGESTS
 * units, attributes and modules; it can be changed later without losing records.
 */
export interface CategoryProfile {
  suggestedUnits: string[]
  trackExpiry: boolean
  trackVariants: boolean
  trackBatches: boolean
}

export const categoryProfiles: Record<BusinessCategory, CategoryProfile> = {
  general_store: { suggestedUnits: ['piece', 'pack', 'carton'], trackExpiry: true, trackVariants: false, trackBatches: false },
  supermarket: { suggestedUnits: ['piece', 'pack', 'carton', 'kg'], trackExpiry: true, trackVariants: false, trackBatches: true },
  // Basic stock only. Prescription / regulated-drug workflows are out of scope.
  pharmacy: { suggestedUnits: ['piece', 'box', 'bottle', 'sachet'], trackExpiry: true, trackVariants: false, trackBatches: true },
  hardware: { suggestedUnits: ['piece', 'bag', 'metre', 'kg', 'litre'], trackExpiry: false, trackVariants: true, trackBatches: false },
  clothing: { suggestedUnits: ['piece', 'pair'], trackExpiry: false, trackVariants: true, trackBatches: false },
  cosmetics: { suggestedUnits: ['piece', 'bottle', 'sachet', 'carton'], trackExpiry: true, trackVariants: true, trackBatches: false },
  wholesale: { suggestedUnits: ['piece', 'pack', 'carton', 'bag'], trackExpiry: true, trackVariants: false, trackBatches: false },
  electronics: { suggestedUnits: ['piece'], trackExpiry: false, trackVariants: true, trackBatches: false },
  agri_supply: { suggestedUnits: ['kg', 'bag', 'litre', 'piece'], trackExpiry: true, trackVariants: false, trackBatches: true },
  other: { suggestedUnits: ['piece', 'pack'], trackExpiry: false, trackVariants: false, trackBatches: false },
}

/**
 * Cameroon mobile numbers: +237 followed by 9 digits starting with 6.
 * Accepts "6XXXXXXXX", "237 6XX XX XX XX", "+237-6XX...". Returns +2376XXXXXXXX or null.
 */
export function normalizeCameroonPhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/^00/, '')
  const local = digits.startsWith('237') ? digits.slice(3) : digits
  return /^6\d{8}$/.test(local) ? `+237${local}` : null
}

export interface OnboardingInput {
  businessName: string
  category: BusinessCategory
  town: string
  address?: string
  ownerName: string
  ownerPhone: string
  language: 'fr' | 'en'
  taxId?: string
  employeeCount: number
  oversellPolicy: 'allow_and_flag' | 'block'
}

export type OnboardingErrors = Partial<Record<keyof OnboardingInput, string>>

/** Returns error CODES (translated in the UI), keyed by field. Empty object = valid. */
export function validateOnboarding(input: OnboardingInput): OnboardingErrors {
  const errors: OnboardingErrors = {}
  if (input.businessName.trim().length < 2) errors.businessName = 'required'
  if (!businessCategories.includes(input.category)) errors.category = 'invalid'
  if (input.town.trim().length < 2) errors.town = 'required'
  if (input.ownerName.trim().length < 2) errors.ownerName = 'required'
  if (!normalizeCameroonPhone(input.ownerPhone)) errors.ownerPhone = 'invalid_phone'
  if (!Number.isInteger(input.employeeCount) || input.employeeCount < 0 || input.employeeCount > 500) {
    errors.employeeCount = 'invalid_number'
  }
  return errors
}

/** Payload sent to the `onboard_business` database function. */
export function toOnboardingPayload(input: OnboardingInput) {
  return {
    business_name: input.businessName.trim(),
    category: input.category,
    town: input.town.trim(),
    address: input.address?.trim() || null,
    owner_name: input.ownerName.trim(),
    owner_phone: normalizeCameroonPhone(input.ownerPhone),
    language: input.language,
    tax_id: input.taxId?.trim() || null,
    employee_count: input.employeeCount,
    oversell_policy: input.oversellPolicy,
  }
}
