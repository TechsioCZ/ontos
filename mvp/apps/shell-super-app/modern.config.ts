import { createUltramodernAppConfig } from '@mvp/ultramodern-config';
import { ultramodernLocalisedUrls } from './src/routes/ultramodern-route-metadata';

export default createUltramodernAppConfig({
  apiPrefix: '/shell-super-app-api',
  appId: 'shell-super-app',
  chunkLoadingGlobal: '__ULTRAMODERN_SHELL_SUPER_APP_LOADED_CHUNKS__',
  cloudflarePublicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP',
  cloudflareWorkerName: 'mvp-shell-super-app',
  defaultPort: 3020,
  devAssetPrefix: 'origin-relative',
  localisedUrls: ultramodernLocalisedUrls as Record<string, Record<string, string>>,
  portEnv: 'SHELL_SUPER_APP_PORT',
  uniqueName: 'shellSuperApp',
});
