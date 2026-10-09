import { defineConfig } from '@modern-js/app-tools';
import type { AppToolsUserConfig } from '@modern-js/app-tools';
import { Predicate } from 'effect';

import commerceConfig from './modern.config.ts';

/**
 * Cloudflare gate case: Commerce built with the whole `@app/catalog/api/client` barrel, which pulls
 * Catalog's root HttpApi (one long `.addHttpApi` chain) into the Commerce workerd graph. The
 * Commerce Cloudflare build crashed on that graph when React Compiler also compiled server code;
 * this build keeps it compiling with the default stack. Production imports only the
 * quantity-preparation client, which stays the narrower dependency surface.
 */
const withFullCatalogClient = (config: AppToolsUserConfig): AppToolsUserConfig => ({
  ...config,
  source: {
    ...config.source,
    preEntry: ['@app/catalog/api/client'],
  },
});

export default defineConfig(async (environment) =>
  withFullCatalogClient(Predicate.isFunction(commerceConfig) ? await commerceConfig(environment) : commerceConfig),
);
