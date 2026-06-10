// @effect-diagnostics processEnv:off
import { appTools, defineConfig, presetUltramodern } from '@modern-js/app-tools';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import moduleFederationConfig from './module-federation.config.ts';

const appId = 'accounting-core';
const port = Number(process.env['ACCOUNTING_CORE_PORT'] ?? 3022);
const siteUrl = process.env['ULTRAMODERN_PUBLIC_URL_ACCOUNTING_CORE'] ?? `http://localhost:${port}`;

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
            .uniqueName('accountingCore')
            .chunkLoadingGlobal('__ONTOS_ACCOUNTING_CORE_LOADED_CHUNKS__');
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
