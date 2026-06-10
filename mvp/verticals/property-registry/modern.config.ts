// @effect-diagnostics processEnv:off
import { appTools, defineConfig, presetUltramodern } from '@modern-js/app-tools';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import moduleFederationConfig from './module-federation.config.ts';

const appId = 'property-registry';
const port = Number(process.env['PROPERTY_REGISTRY_PORT'] ?? 3021);
const siteUrl =
  process.env['ULTRAMODERN_PUBLIC_URL_PROPERTY_REGISTRY'] ?? `http://localhost:${port}`;

export default defineConfig(
  presetUltramodern(
    {
      output: {
        assetPrefix: siteUrl,
        disableTsChecker: true,
        distPath: {
          html: './',
        },
        polyfill: 'off',
      },
      plugins: [
        appTools(),
        tanstackRouterPlugin(),
        moduleFederationPlugin({ config: moduleFederationConfig }),
      ],
      server: {
        port,
        ssr: {
          mode: 'string',
          moduleFederationAppSSR: true,
        },
      },
      source: {
        mainEntryName: 'index',
      },
      tools: {
        bundlerChain: (chain) => {
          chain.output
            .uniqueName('propertyRegistry')
            .chunkLoadingGlobal('__ONTOS_PROPERTY_REGISTRY_LOADED_CHUNKS__');
        },
      },
    },
    {
      appId,
      enableModuleFederationSSR: true,
      telemetryFailLoudStartup: false,
    },
  ),
);
