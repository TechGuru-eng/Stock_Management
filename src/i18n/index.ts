import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

const fr = {
  app: { online: 'En ligne', offline: 'Hors ligne', loading: 'Chargement…', notBuilt: "Ce module n'est pas encore disponible." },
  nav: { home: 'Accueil', sales: 'Ventes', stock: 'Stock', money: 'Argent', more: 'Plus' },
  config: {
    title: 'Configuration requise',
    body: "Renseignez VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY dans le fichier .env.local, puis relancez l'application.",
  },
  auth: {
    title: 'Connexion',
    subtitle: 'Entrez votre numéro de téléphone pour recevoir un code.',
    phone: 'Numéro de téléphone',
    phoneHint: 'Ex. 677 12 34 56',
    sendCode: 'Recevoir le code',
    code: 'Code reçu par SMS',
    verify: 'Valider',
    changeNumber: 'Changer de numéro',
    signOut: 'Se déconnecter',
    offlineNeeded: 'Une connexion internet est nécessaire pour se connecter la première fois.',
    invalidPhone: 'Numéro invalide. Utilisez un numéro camerounais (9 chiffres commençant par 6).',
    sendFailed: "Impossible d'envoyer le code. Réessayez.",
    verifyFailed: 'Code incorrect ou expiré.',
  },
  onboarding: {
    title: 'Créer votre commerce',
    step: 'Étape {{n}} sur {{total}}',
    next: 'Continuer',
    back: 'Retour',
    finish: 'Terminer',
    saving: 'Création en cours…',
    saveFailed: 'La création a échoué. Vérifiez votre connexion et réessayez.',
    s1: 'Votre commerce',
    s2: 'Contact et lieu',
    s3: 'Préférences',
    businessName: 'Nom du commerce',
    category: "Type d'activité",
    categoryHint: 'Vous pourrez le changer plus tard sans perdre vos données.',
    town: 'Ville',
    address: 'Adresse (facultatif)',
    ownerName: 'Votre nom',
    ownerPhone: 'Téléphone du propriétaire',
    employees: "Nombre d'employés",
    language: 'Langue',
    currency: 'Monnaie : FCFA (XAF)',
    taxId: 'Numéro de contribuable (facultatif)',
    oversell: 'Vente hors ligne si le stock affiché est insuffisant',
    oversellAllow: 'Autoriser et signaler au responsable (recommandé)',
    oversellBlock: 'Bloquer la vente',
    trialNote: 'Essai gratuit inclus. Aucun paiement maintenant.',
    errors: { required: 'Champ obligatoire', invalid_phone: 'Numéro invalide', invalid_number: 'Nombre invalide', invalid: 'Valeur invalide' },
  },
  categories: {
    general_store: 'Boutique / magasin général',
    supermarket: 'Supermarché / mini-market',
    pharmacy: 'Pharmacie / produits de santé',
    hardware: 'Quincaillerie / matériaux',
    clothing: 'Vêtements et chaussures',
    cosmetics: 'Cosmétiques et beauté',
    wholesale: 'Grossiste / distributeur',
    electronics: 'Électronique et accessoires',
    agri_supply: 'Intrants agricoles',
    other: 'Autre commerce',
  },
}

const en: typeof fr = {
  app: { online: 'Online', offline: 'Offline', loading: 'Loading…', notBuilt: 'This module is not available yet.' },
  nav: { home: 'Home', sales: 'Sales', stock: 'Stock', money: 'Money', more: 'More' },
  config: {
    title: 'Setup required',
    body: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the .env.local file, then restart the app.',
  },
  auth: {
    title: 'Sign in',
    subtitle: 'Enter your phone number to receive a code.',
    phone: 'Phone number',
    phoneHint: 'E.g. 677 12 34 56',
    sendCode: 'Send code',
    code: 'Code received by SMS',
    verify: 'Verify',
    changeNumber: 'Change number',
    signOut: 'Sign out',
    offlineNeeded: 'You need an internet connection the first time you sign in.',
    invalidPhone: 'Invalid number. Use a Cameroon number (9 digits starting with 6).',
    sendFailed: 'Could not send the code. Please try again.',
    verifyFailed: 'Wrong or expired code.',
  },
  onboarding: {
    title: 'Set up your business',
    step: 'Step {{n}} of {{total}}',
    next: 'Continue',
    back: 'Back',
    finish: 'Finish',
    saving: 'Creating…',
    saveFailed: 'Setup failed. Check your connection and try again.',
    s1: 'Your business',
    s2: 'Contact and location',
    s3: 'Preferences',
    businessName: 'Business name',
    category: 'Type of business',
    categoryHint: 'You can change this later without losing your data.',
    town: 'Town',
    address: 'Address (optional)',
    ownerName: 'Your name',
    ownerPhone: "Owner's phone",
    employees: 'Number of employees',
    language: 'Language',
    currency: 'Currency: FCFA (XAF)',
    taxId: 'Tax ID (optional)',
    oversell: 'Offline sale when the stock shown is too low',
    oversellAllow: 'Allow and alert the manager (recommended)',
    oversellBlock: 'Block the sale',
    trialNote: 'Free trial included. No payment now.',
    errors: { required: 'Required', invalid_phone: 'Invalid number', invalid_number: 'Invalid number', invalid: 'Invalid value' },
  },
  categories: {
    general_store: 'General store / boutique',
    supermarket: 'Supermarket / mini-market',
    pharmacy: 'Pharmacy / health products',
    hardware: 'Hardware / building materials',
    clothing: 'Clothing and footwear',
    cosmetics: 'Cosmetics and beauty',
    wholesale: 'Wholesale / distributor',
    electronics: 'Electronics and accessories',
    agri_supply: 'Agricultural supplies',
    other: 'Other business',
  },
}

const stored = (() => {
  try {
    return localStorage.getItem('stockcm.lang')
  } catch {
    return null
  }
})()

void i18n.use(initReactI18next).init({
  resources: { fr: { translation: fr }, en: { translation: en } },
  lng: stored === 'en' ? 'en' : 'fr',
  fallbackLng: 'fr',
  interpolation: { escapeValue: false },
})

export function setLanguage(lang: 'fr' | 'en') {
  void i18n.changeLanguage(lang)
  try {
    localStorage.setItem('stockcm.lang', lang)
  } catch {
    /* storage unavailable: language just won't persist */
  }
}

export default i18n
