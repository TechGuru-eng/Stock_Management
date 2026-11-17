import { normalizeCameroonPhone } from './onboarding'

/**
 * WhatsApp reminders WITHOUT any WhatsApp account or API: we build a "click to chat" link (https://wa.me/<number>?text=...)
 * that opens WhatsApp with the message already typed, and the person presses Send. Nothing is sent automatically, so there is
 * no cost, no approval from Meta, and nobody gets a message they did not mean to send.
 */

export type Lang = 'fr' | 'en'

/** Fills {placeholders}. Unknown placeholders are left empty rather than showing "{x}" to a customer. */
export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? '')).replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim()
}

/** The wa.me link for a Cameroon number, or null when the number is not usable. WhatsApp wants digits only, with the country code. */
export function waLink(phone: string | null | undefined, text: string): string | null {
  const n = phone ? normalizeCameroonPhone(phone) : null
  if (!n) return null
  return `https://wa.me/${n.slice(1)}?text=${encodeURIComponent(text)}`
}

/* --------------------------- customer debt reminder --------------------------- */

export const DEBT_TEMPLATE: Record<Lang, string> = {
  fr: 'Bonjour {name}, ici {shop}. Il vous reste {amount} à régler chez nous. Merci de passer ou de payer par Mobile Money quand vous pouvez. Merci !',
  en: 'Hello {name}, this is {shop}. You still have {amount} to settle with us. Please come by or pay by Mobile Money when you can. Thank you!',
}

/** "2 500 FCFA" with ordinary spaces (WhatsApp shows narrow no-break spaces badly on some phones). */
export function moneyText(n: number): string {
  return `${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`
}

/** The customer's first name reads friendlier in a message, but only when there is more than one word. */
export function firstName(full: string): string {
  const parts = full.trim().split(/\s+/)
  return parts.length > 1 ? parts[0] : full.trim()
}

/* -------------------------- subscription reminders (staff) -------------------------- */

export type RenewalKind = 'renewal_5d' | 'renewal_2d' | 'grace_started' | 'expired'

export const RENEWAL_TEMPLATE: Record<RenewalKind, Record<Lang, string>> = {
  renewal_5d: {
    fr: "Bonjour {name}, votre abonnement StockCM ({plan}) pour {business} se termine le {date} (dans {days} jours). Pour continuer sans interruption, renouvelez dans l'application. Merci !",
    en: 'Hello {name}, your StockCM subscription ({plan}) for {business} ends on {date} ({days} days left). To carry on without interruption, renew in the app. Thank you!',
  },
  renewal_2d: {
    fr: "Bonjour {name}, rappel : votre abonnement StockCM pour {business} se termine le {date}. Renouvelez dès maintenant pour ne pas perdre l'accès à l'enregistrement de vos ventes.",
    en: 'Hello {name}, reminder: your StockCM subscription for {business} ends on {date}. Renew now so you do not lose the ability to record sales.',
  },
  grace_started: {
    fr: "Bonjour {name}, l'abonnement StockCM de {business} a expiré le {date}. Vous pouvez encore travailler quelques jours : renouvelez maintenant pour éviter le mode lecture seule.",
    en: 'Hello {name}, the StockCM subscription for {business} expired on {date}. You can still work for a few days: renew now to avoid read-only mode.',
  },
  expired: {
    fr: "Bonjour {name}, l'abonnement StockCM de {business} est expiré : l'application est en lecture seule. Vos données sont conservées. Renouvelez pour enregistrer de nouvelles opérations.",
    en: 'Hello {name}, the StockCM subscription for {business} has expired and the app is read-only. Your data is safe. Renew to record new transactions.',
  },
}

/** Which message suits a business, from how many days remain (negative = already ended) and the grace length. */
export function renewalKind(daysLeft: number, graceDays: number): RenewalKind | null {
  if (daysLeft > 5) return null
  if (daysLeft > 2) return 'renewal_5d'
  if (daysLeft >= 0) return 'renewal_2d'
  if (-daysLeft <= graceDays) return 'grace_started'
  return 'expired'
}

/** Whole days from `now` to `end` (rounded up while any part of a day remains; negative once ended). */
export function daysLeft(endIso: string, now: Date): number {
  return Math.ceil((new Date(endIso).getTime() - now.getTime()) / 86_400_000)
}
