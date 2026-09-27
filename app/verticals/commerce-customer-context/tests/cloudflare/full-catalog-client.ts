import { createCatalogClient, executeQuantityPreparationWithAuthorization } from '@app/catalog/api/client';

// Keeps the whole Catalog client barrel, and with it Catalog's root HttpApi, in the Commerce
// Cloudflare build graph of the full-catalog-client guard build.
Reflect.set(globalThis, '__ontosFullCatalogClientGuard', [
  createCatalogClient,
  executeQuantityPreparationWithAuthorization,
]);
