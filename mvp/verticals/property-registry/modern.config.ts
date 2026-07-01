import { createUltramodernAppConfig } from '@mvp/ultramodern-config';
import { ultramodernLocalisedUrls } from './src/routes/ultramodern-route-metadata';

export default createUltramodernAppConfig({
  apiPrefix: '/property-registry-api',
  appId: 'property-registry',
  chunkLoadingGlobal: '__ULTRAMODERN_VERTICAL_PROPERTY_REGISTRY_LOADED_CHUNKS__',
  cloudflarePublicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_PROPERTY_REGISTRY',
  cloudflareWorkerName: 'mvp-property-registry',
  defaultPort: 4101,
  devAssetPrefix: 'self-origin',
  localisedUrls: ultramodernLocalisedUrls as Record<string, Record<string, string>>,
  portEnv: 'VERTICAL_PROPERTY_REGISTRY_PORT',
  uniqueName: 'verticalPropertyRegistry',
});
