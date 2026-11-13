import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PAYMENT_GATEWAY_RELAY_PATH_PREFIX } from '@app/payment/payment-gateway-relay';
import { SYMMY_REST_PREFIX } from '@app/shared-contracts/symmy/route-catalog';
import { defineConfig, presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';
import { bffPlugin } from '@modern-js/plugin-bff-build-extensions';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { moduleFederationPlugin } from '@module-federation/modern-js-v3';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { getBuildConfigEnvironment, resolveDeployTarget } from '@modern-js/app-tools-extensions/config';
import { getOrThrow as getResultOrThrow } from 'effect/Result';
import {
  Array as SchemaArray,
  Literal,
  NonEmptyString,
  Struct,
  check,
  decodeUnknownResult,
  fromJsonString,
  is,
  makeFilter,
} from 'effect/Schema';
import { createWorkspaceModernConfig } from '../../packages/shared-contracts/tooling/modern-config.ts';

const appId = 'shell-super-app';
const shellBffPrefix = '/shell-super-app-api';
// PSP notifications and the Payment reconciliation driver reach Shell at the relay's own path on every deployment.
// The relay contract module loads Effect, which the config loader must not evaluate, so only its type is imported.
const paymentGatewayRelayPrefix = '/api/payment/v1' satisfies typeof PAYMENT_GATEWAY_RELAY_PATH_PREFIX;
const internalSymmyIngress =
  is(Literal('1'))(getBuildConfigEnvironment('ONTOS_INTERNAL_SYMMY_INGRESS')) &&
  resolveDeployTarget().target === 'node';

const referenceTopologyPath = fileURLToPath(new URL('../../topology/reference-topology.json', import.meta.url));
// This is a build check of the native BFF convention, never a runtime module registry.
const NativeBffTopologySchema = Struct({
  verticals: SchemaArray(
    Struct({
      api: Struct({ bff: Struct({ prefix: NonEmptyString }) }),
      id: NonEmptyString,
    }).pipe(
      check(
        makeFilter(({ api, id }) =>
          api.bff.prefix === `/${id}-api` ? undefined : `Native module dispatch requires /${id}-api`,
        ),
      ),
    ),
  ),
});
getResultOrThrow(
  decodeUnknownResult(fromJsonString(NativeBffTopologySchema))(readFileSync(referenceTopologyPath, 'utf-8')),
);

const ontos = createWorkspaceModernConfig({
  appId,
  moduleUrl: import.meta.url,
});

export default defineConfig(
  presetUltramodernWorkspace(
    {
      ...ontos,
      bff: {
        effect: {
          entry: './api/index',
          openapi: { path: '/openapi.json' },
          strictEffectApproach: true,
        },
        prefix: [shellBffPrefix, paymentGatewayRelayPrefix, ...(internalSymmyIngress ? [SYMMY_REST_PREFIX] : [])],
        runtimeFramework: 'effect',
      },
      builderPlugins: [pluginTailwindcss()],
      deploy: { releaseEnvelopeRole: 'shell' },
      dev: getBuildConfigEnvironment('CI') ? { ...ontos.dev, lazyCompilation: false } : ontos.dev,
      plugins: [
        bffPlugin(),
        tanstackRouterPlugin(),
        i18nPlugin({
          backend: {
            enabled: true,
            loadPath: '/locales/{{lng}}/{{ns}}.json',
          },
          localeDetection: {
            fallbackLanguage: 'en',
            ignoreRedirectRoutes: [
              // The Shell runtime contract the Application Composition publisher observes.
              '/.well-known',
              '/@mf-types',
              '/assets',
              '/bundles',
              '/favicon.ico',
              shellBffPrefix,
              paymentGatewayRelayPrefix,
              ...(internalSymmyIngress ? [SYMMY_REST_PREFIX] : []),
              '/locales',
              '/mf-manifest.json',
              '/mf-stats.json',
              '/remoteEntry.js',
              '/robots.txt',
              '/site.webmanifest',
              '/sitemap.xml',
              '/static',
              '/zephyr-manifest.json',
            ],
            languages: ['en', 'cs'],
            localePathRedirect: true,
          },
          reactI18next: false,
        }),
        moduleFederationPlugin({
          configPath: fileURLToPath(new URL('module-federation.config.ts', import.meta.url)),
        }),
      ],
      server: {
        ...ontos.server,
        publicDir: ['./.dev-public', './locales', './assets'],
        ssr: { mode: 'stream', moduleFederationAppSSR: true },
      },
      source: {
        ...ontos.source,
        globalVars: {
          ...ontos.source.globalVars,
          'globalThis.ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT':
            getBuildConfigEnvironment('ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT') ?? 'http://localhost:3070',
          'globalThis.ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT':
            getBuildConfigEnvironment('ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT') ?? '',
        },
      },
      splitChunks: { chunks: 'async' },
    },
    {
      appId,
      enableBffRequestId: true,
      enableModuleFederationSSR: true,
      enableTelemetryExporters: true,
      from: import.meta.url,
      telemetryFailLoudStartup: false,
    },
  ),
);
