import { createUltramodernAppConfig } from '@mvp/ultramodern-config';
import { ultramodernLocalisedUrls } from './src/routes/ultramodern-route-metadata';

export default createUltramodernAppConfig({
  apiPrefix: '/accounting-core-api',
  appId: 'accounting-core',
  chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_ACCOUNTING_CORE_LOADED_CHUNKS__',
  cloudflarePublicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_ACCOUNTING_CORE',
  cloudflareWorkerName: 'mvp-accounting-core',
  defaultPort: 4102,
  devAssetPrefix: 'self-origin',
  localisedUrls: ultramodernLocalisedUrls as Record<string, Record<string, string>>,
  portEnv: 'VERTICAL_ACCOUNTING_CORE_PORT',
  uniqueName: 'verticalAccountingCore',
});
