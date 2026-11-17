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
  stock: {
    title: 'Stock', products: 'Produits', newProduct: 'Nouveau produit', search: 'Rechercher un produit…',
    onHand: 'En stock', low: 'Stock bas', none: 'Aucun produit pour le moment.',
    name: 'Nom du produit', barcode: 'Code-barres (facultatif)', isService: 'Service (sans stock)',
    baseUnit: "Unité de base (ex. bouteille, kg)", basePrice: "Prix de vente par unité de base (FCFA)",
    bigUnit: 'Grand conditionnement (facultatif)', bigUnitName: 'Nom (ex. carton)',
    bigUnitFactor: "Combien d'unités de base dedans ?", bigUnitPrice: 'Prix du conditionnement (FCFA)',
    minStock: 'Alerte stock minimum', taxPercent: 'Taxe (%)', openingQty: 'Stock initial (unités de base)',
    openingCost: 'Coût total du stock initial (FCFA)', save: 'Enregistrer', cancel: 'Annuler',
    receive: 'Réception de marchandise', remove: 'Sortie de stock', quantity: 'Quantité', unit: 'Unité',
    totalCost: 'Coût total (FCFA)', reason: 'Motif (obligatoire)', reasonType: 'Type de sortie',
    damaged: 'Endommagé', expired: 'Périmé', missing: 'Manquant ou volé', giveaway: 'Cadeau', personal_use: 'Usage personnel',
    done: 'Enregistré.', noPermission: "Vous n'avez pas la permission.", error: 'Erreur : {{msg}}', back: 'Retour',
  },
  pos: {
    title: 'Vente', search: 'Nom ou code-barres (Entrée)', cart: 'Panier', empty: 'Le panier est vide.',
    discount: 'Remise (FCFA)', subtotal: 'Sous-total', tax: 'Taxe', total: 'Total', remove: 'Retirer',
    customer: 'Client', walkIn: 'Client de passage', newCustomer: 'Nouveau client', customerName: 'Nom du client',
    customerPhone: 'Téléphone', creditLimit: 'Limite de crédit (FCFA)', payments: 'Paiements',
    cash: 'Espèces', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money', credit: 'Crédit client',
    amount: 'Montant', add: 'Ajouter', remaining: 'Reste à répartir', payFull: 'Tout en espèces',
    complete: 'Valider la vente', saleDone: 'Vente enregistrée', whatsapp: 'Envoyer par WhatsApp', print: 'Imprimer',
    newSale: 'Nouvelle vente', oversold: "Stock affiché insuffisant : le responsable sera alerté.", noResults: 'Aucun produit trouvé.',
    notRecorded: 'Un paiement MoMo / Orange saisi ici est enregistré mais pas vérifié par l’opérateur.', save: 'Créer',
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
  stock: {
    title: 'Stock', products: 'Products', newProduct: 'New product', search: 'Search a product…',
    onHand: 'In stock', low: 'Low stock', none: 'No products yet.',
    name: 'Product name', barcode: 'Barcode (optional)', isService: 'Service (no stock)',
    baseUnit: 'Base unit (e.g. bottle, kg)', basePrice: 'Selling price per base unit (FCFA)',
    bigUnit: 'Larger pack (optional)', bigUnitName: 'Name (e.g. carton)',
    bigUnitFactor: 'How many base units inside?', bigUnitPrice: 'Pack price (FCFA)',
    minStock: 'Minimum stock alert', taxPercent: 'Tax (%)', openingQty: 'Opening stock (base units)',
    openingCost: 'Total cost of opening stock (FCFA)', save: 'Save', cancel: 'Cancel',
    receive: 'Receive goods', remove: 'Remove stock', quantity: 'Quantity', unit: 'Unit',
    totalCost: 'Total cost (FCFA)', reason: 'Reason (required)', reasonType: 'Removal type',
    damaged: 'Damaged', expired: 'Expired', missing: 'Missing or stolen', giveaway: 'Giveaway', personal_use: 'Personal use',
    done: 'Saved.', noPermission: 'You do not have permission.', error: 'Error: {{msg}}', back: 'Back',
  },
  pos: {
    title: 'Sale', search: 'Name or barcode (Enter)', cart: 'Cart', empty: 'The cart is empty.',
    discount: 'Discount (FCFA)', subtotal: 'Subtotal', tax: 'Tax', total: 'Total', remove: 'Remove',
    customer: 'Customer', walkIn: 'Walk-in customer', newCustomer: 'New customer', customerName: 'Customer name',
    customerPhone: 'Phone', creditLimit: 'Credit limit (FCFA)', payments: 'Payments',
    cash: 'Cash', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money', credit: 'Customer credit',
    amount: 'Amount', add: 'Add', remaining: 'Left to allocate', payFull: 'All in cash',
    complete: 'Complete sale', saleDone: 'Sale recorded', whatsapp: 'Send on WhatsApp', print: 'Print',
    newSale: 'New sale', oversold: 'Shown stock is too low: the manager will be alerted.', noResults: 'No product found.',
    notRecorded: 'A MoMo / Orange payment entered here is recorded but not verified by the operator.', save: 'Create',
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
