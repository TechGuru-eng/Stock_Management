import { loadKnownProducts } from '../../data/importRepo'

/** The catalogue as the supplier price import needs it (no shop-specific stock history involved). */
export const importCatalogueForSuppliers = () => loadKnownProducts()
