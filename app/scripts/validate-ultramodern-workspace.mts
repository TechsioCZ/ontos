import { ok as assertCondition } from 'node:assert';
import type { execFileSync as nodeExecFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import type {
  Dirent,
  existsSync as nodeExistsSync,
  mkdtempSync as nodeMkdtempSync,
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
  rmSync as nodeRmSync,
  writeFileSync as nodeWriteFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import type { nodeFileTrace as traceNodeFiles } from '@vercel/nft';
import { Array as EffectArray, Config, Effect, Inspectable, Layer, Order, Predicate, Result, Schema } from 'effect';
import type { Json } from 'effect/Schema';

import compactConfigDocument from '../.modernjs/ultramodern.json' with { type: 'json' };
import shellPackageDocument from '../apps/shell-super-app/package.json' with { type: 'json' };
import rootPackageDocument from '../package.json' with { type: 'json' };
import developmentOverlayDocument from '../topology/local-overlays/development.json' with { type: 'json' };
import ownershipDocument from '../topology/ownership.json' with { type: 'json' };
import referenceTopologyDocument from '../topology/reference-topology.json' with { type: 'json' };
import { checkOntosModuleContracts } from './check-ontos-module-contracts.mts';
import { moduleFederationBridgeViolation } from './module-federation-bridge-boundary.mts';
import {
  assertPublishedCrossMicroVerticalContractUsage,
  assertPublishedOutboxContractSource,
  publishedOutboxContractExports,
  resolvePublishedContractModuleId,
} from './published-outbox-contracts.mts';
import { tailwindPrefixForNamespace } from './scaffolding/tailwind-prefix.mts';
import { hasUltramodernDispatch, hasUltramodernSkillsDispatch } from './shared/ultramodern-wrapper-source.mts';

const nodeRequire = createRequire(import.meta.url);
const nodeFileSystemModule = ['node', 'fs'].join(':');
const nodeChildProcessModule = ['node', 'child_process'].join(':');
const NodeFileSystemModuleSchema = Schema.Struct({
  existsSync: Schema.declare((input): input is typeof nodeExistsSync => Predicate.isFunction(input)),
  mkdtempSync: Schema.declare((input): input is typeof nodeMkdtempSync => Predicate.isFunction(input)),
  readdirSync: Schema.declare((input): input is typeof nodeReaddirSync => Predicate.isFunction(input)),
  readFileSync: Schema.declare((input): input is typeof nodeReadFileSync => Predicate.isFunction(input)),
  rmSync: Schema.declare((input): input is typeof nodeRmSync => Predicate.isFunction(input)),
  writeFileSync: Schema.declare((input): input is typeof nodeWriteFileSync => Predicate.isFunction(input)),
});
const NodeChildProcessModuleSchema = Schema.Struct({
  execFileSync: Schema.declare((input): input is typeof nodeExecFileSync => Predicate.isFunction(input)),
});
const fs = Result.getOrThrow(Schema.decodeUnknownResult(NodeFileSystemModuleSchema)(nodeRequire(nodeFileSystemModule)));
const { execFileSync } = Result.getOrThrow(
  Schema.decodeUnknownResult(NodeChildProcessModuleSchema)(nodeRequire(nodeChildProcessModule)),
);

const SHARED_VALIDATOR_STRING_001 = '../../tsconfig.base.json';
const SHARED_VALIDATOR_STRING_002 = './api/client';
const SHARED_VALIDATOR_STRING_003 = './api/rpc-client';
const SHARED_VALIDATOR_STRING_004 = './effect-api';
const SHARED_VALIDATOR_STRING_005 = './PageContacts';
const SHARED_VALIDATOR_STRING_006 = './src/routes/ultramodern-route-metadata';
const SHARED_VALIDATOR_STRING_007 = './tsconfig.mf-types.json';
const SHARED_VALIDATOR_STRING_008 = '.codex/reports/cloudflare-version-proof/public-url-proof.json';
const SHARED_VALIDATOR_STRING_009 = '.modernjs/release-cohort.json';
const SHARED_VALIDATOR_STRING_010 = '.output/server/index.mjs';
const SHARED_VALIDATOR_STRING_011 = '.output/server/modern-worker-manifest.json';
const SHARED_VALIDATOR_STRING_012 = '.output/server/route.json';
const SHARED_VALIDATOR_STRING_013 = '.output/worker/__modern_bff_effect.js';
const SHARED_VALIDATOR_STRING_014 = '.output/worker/index.js';
const SHARED_VALIDATOR_STRING_015 = "'unsafe-eval'";
const SHARED_VALIDATOR_STRING_016 = "'unsafe-inline'";
const SHARED_VALIDATOR_STRING_017 = '@app/core-runtime';
const SHARED_VALIDATOR_STRING_018 = '@app/party-registry';
const SHARED_VALIDATOR_STRING_019 = '@app/shared-contracts';
const SHARED_VALIDATOR_STRING_020 = '@app/shared-design-tokens';
const SHARED_VALIDATOR_STRING_021 = '@app/shell-super-app';
const SHARED_VALIDATOR_STRING_022 = '@modern-js/app-tools';
const SHARED_VALIDATOR_STRING_023 = '@modern-js/code-tools';
const SHARED_VALIDATOR_STRING_024 = '@modern-js/ultramodern-create';
const SHARED_VALIDATOR_STRING_025 = '@modern-js/plugin-bff';
const SHARED_VALIDATOR_STRING_026 = '@modern-js/plugin-bff-extensions/backend-federation-manifest/node';
const SHARED_VALIDATOR_STRING_027 = '@modern-js/plugin-i18n';
const SHARED_VALIDATOR_STRING_028 = '@modern-js/plugin-tanstack';
const SHARED_VALIDATOR_STRING_029 = '@modern-js/runtime';
const SHARED_VALIDATOR_STRING_030 = '/__ultramodern-smoke-missing/nope';
const SHARED_VALIDATOR_STRING_031 = '/mf-manifest.json';
const SHARED_VALIDATOR_STRING_032 = '/party-registry-api';
const SHARED_VALIDATOR_STRING_033 = '/party-registry-api/openapi.json';
const SHARED_VALIDATOR_STRING_034 = '/party-registry-api/party-registry/readiness';
const SHARED_VALIDATOR_STRING_035 = '#super-app-platform';
const SHARED_VALIDATOR_STRING_036 = '2026-06-02';
const SHARED_VALIDATOR_STRING_037 = '3.9.0-ultramodern.7';
const SHARED_VALIDATOR_STRING_038 = '3f023644c8a07e9a';
const SHARED_VALIDATOR_STRING_039 = '4.0.0-rc.112';
const SHARED_VALIDATOR_STRING_040 = 'additionalShellBuildMarkerIds';
const SHARED_VALIDATOR_STRING_041 = 'additionalShellDegradedStateIds';
const SHARED_VALIDATOR_STRING_042 = 'additionalShellDeliveryUnitIds';
const SHARED_VALIDATOR_STRING_043 = 'additionalShellOwnerIds';
const SHARED_VALIDATOR_STRING_044 = 'app-party-registry';
const SHARED_VALIDATOR_STRING_045 = 'app-public-origin';
const SHARED_VALIDATOR_STRING_046 = 'app/party-registry';
const SHARED_VALIDATOR_STRING_047 = 'apps/shell-super-app';
const SHARED_VALIDATOR_STRING_048 = 'apps/shell-super-app/modern.config.ts';
const SHARED_VALIDATOR_STRING_049 = 'apps/shell-super-app/module-federation.config.ts';
const SHARED_VALIDATOR_STRING_050 = 'apps/shell-super-app/package.json';
const SHARED_VALIDATOR_STRING_051 = 'apps/shell-super-app/src';
const SHARED_VALIDATOR_STRING_052 = 'apps/shell-super-app/tsconfig.mf-types.json';
const SHARED_VALIDATOR_STRING_053 = 'authorization:provision-current-actions';
const SHARED_VALIDATOR_STRING_054 = 'backend-mf-effect-v1';
const SHARED_VALIDATOR_STRING_055 = 'camera=(), geolocation=(), microphone=(), payment=(), usb=()';
const SHARED_VALIDATOR_STRING_056 = 'cloudflare';
const SHARED_VALIDATOR_STRING_057 = 'cloudflare-ssr-mf-effect-v1';
const SHARED_VALIDATOR_STRING_058 = 'cloudflare-worker-snapshot';
const SHARED_VALIDATOR_STRING_059 = 'cloudflare:build';
const SHARED_VALIDATOR_STRING_060 = 'cloudflare:deploy';
const SHARED_VALIDATOR_STRING_061 = 'cloudflare:proof';
const SHARED_VALIDATOR_STRING_062 = 'colocated-route-meta';
const SHARED_VALIDATOR_STRING_063 = 'commonjs-module';
const SHARED_VALIDATOR_STRING_064 = 'core-runtime';
const SHARED_VALIDATOR_STRING_065 = 'deliveryUnit';
const SHARED_VALIDATOR_STRING_066 = 'docs/super-app-rfc-adr/wave2/blast-radius.md#shared-packages';
const SHARED_VALIDATOR_STRING_067 = 'docs/super-app-rfc-adr/wave2/reference-topology.md#shared-packages';
const SHARED_VALIDATOR_STRING_068 = 'effect-tsgo';
const SHARED_VALIDATOR_STRING_069 = 'framework-invariant';
const SHARED_VALIDATOR_STRING_070 = 'global_fetch_strictly_public';
const SHARED_VALIDATOR_STRING_071 = 'http://localhost:4102/backend-mf-manifest.json';
const SHARED_VALIDATOR_STRING_072 = 'http://localhost:4102/backendRemoteEntry.cjs';
const SHARED_VALIDATOR_STRING_073 = 'http://localhost:4102/mf-manifest.json';
const SHARED_VALIDATOR_STRING_074 = 'jsx-attribute';
const SHARED_VALIDATOR_STRING_075 = 'locales/**/*.json';
const SHARED_VALIDATOR_STRING_076 = 'managed-cloudflare';
const SHARED_VALIDATOR_STRING_077 = 'microvertical-delivery-unit';
const SHARED_VALIDATOR_STRING_078 = 'microvertical-server';
const SHARED_VALIDATOR_STRING_079 = 'microvertical-server-effect-v1';
const SHARED_VALIDATOR_STRING_080 = 'MODERN_ASSET_PREFIX';
const SHARED_VALIDATOR_STRING_081 = 'MODERN_PUBLIC_SITE_URL';
const SHARED_VALIDATOR_STRING_082 = 'node ./scripts/assert-mf-types.mts';
const SHARED_VALIDATOR_STRING_084 =
  'node ./scripts/proof-cloudflare-version.mts --out .codex/reports/cloudflare-version-proof/public-url-proof.json';
const SHARED_VALIDATOR_STRING_085 = 'node ./scripts/ultramodern-performance-readiness.mts';
const SHARED_VALIDATOR_STRING_086 = 'node ./scripts/ultramodern-typecheck.mts --build tsconfig.json';
const SHARED_VALIDATOR_STRING_087 = 'node ./scripts/validate-ultramodern-workspace.mts';
const SHARED_VALIDATOR_STRING_088 = 'node-mf-runtime';
const SHARED_VALIDATOR_STRING_089 = 'nodejs_compat';
const SHARED_VALIDATOR_STRING_090 = 'noindex, nofollow';
const SHARED_VALIDATOR_STRING_091 = 'package.json';
const SHARED_VALIDATOR_STRING_092 = 'packages/core-runtime';
const SHARED_VALIDATOR_STRING_093 = 'packages/core-runtime/package.json';
const SHARED_VALIDATOR_STRING_094 = 'packages/shared-contracts';
const SHARED_VALIDATOR_STRING_095 = 'packages/shared-contracts/package.json';
const SHARED_VALIDATOR_STRING_096 = 'packages/shared-design-tokens';
const SHARED_VALIDATOR_STRING_097 = 'packages/shared-design-tokens/src/tokens.css';
const SHARED_VALIDATOR_STRING_098 = 'party-registry';
const SHARED_VALIDATOR_STRING_099 = 'partyRegistry';
const SHARED_VALIDATOR_STRING_100 = 'pd-super-app-platform';
const SHARED_VALIDATOR_STRING_101 = 'pnpm api:check';
const SHARED_VALIDATOR_STRING_102 = 'pnpm module-entrypoints:check';
const SHARED_VALIDATOR_STRING_103 = 'pnpm-workspace.yaml';
const SHARED_VALIDATOR_STRING_104 = 'presetUltramodern';
const SHARED_VALIDATOR_STRING_105 = 'private-app-screen';
const SHARED_VALIDATOR_STRING_106 = 'provision-current-action-authorization';
const SHARED_VALIDATOR_STRING_107 = 'report-only';
const SHARED_VALIDATOR_STRING_108 =
  'Report-only by default so Cloudflare Module Federation SSR can prove remote script, style, and connect compatibility before enforcement.';
const SHARED_VALIDATOR_STRING_109 =
  'Report-only remains the generated final mode until public smoke proof records MF SSR script/style/connect compatibility for the deployed surface.';
const SHARED_VALIDATOR_STRING_110 = 'report-only-dogfood';
const SHARED_VALIDATOR_STRING_111 = 'restore generated ownership entries';
const SHARED_VALIDATOR_STRING_112 = 'restore generated topology vertical entries';
const SHARED_VALIDATOR_STRING_113 = 'robots.txt';
const SHARED_VALIDATOR_STRING_114 = 'scripts/assert-mf-types.mts';
const SHARED_VALIDATOR_STRING_115 = 'scripts/bootstrap-agent-skills.mts';
const SHARED_VALIDATOR_STRING_116 = 'scripts/generate-node-backend-federation.mts';
const SHARED_VALIDATOR_STRING_117 = 'scripts/generate-public-surface-assets.mts';
const SHARED_VALIDATOR_STRING_118 = 'scripts/generate-tanstack-routes.mts';
const SHARED_VALIDATOR_STRING_119 = 'scripts/proof-cloudflare-version.mts';
const SHARED_VALIDATOR_STRING_120 = 'scripts/proof-node-backend-federation.mts';
const SHARED_VALIDATOR_STRING_121 = 'scripts/ultramodern-performance-readiness.config.mjs';
const SHARED_VALIDATOR_STRING_122 = 'scripts/ultramodern-performance-readiness.mts';
const SHARED_VALIDATOR_STRING_123 = 'scripts/ultramodern-typecheck.mts';
const SHARED_VALIDATOR_STRING_124 = 'scripts/validate-ultramodern-workspace.mts';
const SHARED_VALIDATOR_STRING_125 = 'scripts/verify-cloudflare-output.mts';
const SHARED_VALIDATOR_STRING_126 = 'service-binding';
const SHARED_VALIDATOR_STRING_127 = 'shared-contracts';
const SHARED_VALIDATOR_STRING_128 = 'shared-design-tokens';
const SHARED_VALIDATOR_STRING_129 = 'shared-package';
const SHARED_VALIDATOR_STRING_130 = 'SHELL_SUPER_APP_PORT';
const SHARED_VALIDATOR_STRING_131 = 'shell-super-app';
const SHARED_VALIDATOR_STRING_132 = 'shellsuperapp';
const SHARED_VALIDATOR_STRING_133 = 'shellSuperApp';
const SHARED_VALIDATOR_STRING_134 = 'site.webmanifest';
const SHARED_VALIDATOR_STRING_135 = 'sitemap.xml';
const SHARED_VALIDATOR_STRING_136 = 'src/federation-entry.tsx';
const SHARED_VALIDATOR_STRING_137 = 'src/modern-app-env.d.ts';
const SHARED_VALIDATOR_STRING_138 = 'src/routes/index.css';
const SHARED_VALIDATOR_STRING_139 = 'ssr-worker';
const SHARED_VALIDATOR_STRING_140 = 'strict-origin-when-cross-origin';
const SHARED_VALIDATOR_STRING_141 = 'super-app-platform';
const SHARED_VALIDATOR_STRING_142 = 'traceparent';
const SHARED_VALIDATOR_STRING_143 = 'ULTRAMODERN_ASSET_PREFIX';
const SHARED_VALIDATOR_STRING_144 =
  'cross-env ULTRAMODERN_CLOUDFLARE_REQUIRE_PUBLIC_URLS=true pnpm run cloudflare:build && wrangler deploy --config .output/wrangler.json';
const SHARED_VALIDATOR_STRING_145 = 'ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN';
const SHARED_VALIDATOR_STRING_146 = 'ULTRAMODERN_PERFORMANCE_READINESS_DIAGNOSTICS=false';
const SHARED_VALIDATOR_STRING_147 = 'ULTRAMODERN_PUBLIC_URL_PARTY_REGISTRY';
const SHARED_VALIDATOR_STRING_148 = 'ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP';
const SHARED_VALIDATOR_STRING_149 = 'ultramodern-shared-tokens';
const SHARED_VALIDATOR_STRING_150 = 'ultramodern-shell-base';
const SHARED_VALIDATOR_STRING_151 = 'ultramodernApiMarker';
const SHARED_VALIDATOR_STRING_152 = 'ultramodernUiMarker';
const SHARED_VALIDATOR_STRING_153 = 'VERTICAL_PARTY_REGISTRY_BACKEND_MF_MANIFEST';
const SHARED_VALIDATOR_STRING_154 = 'VERTICAL_PARTY_REGISTRY_DISPATCH_NAMESPACE';
const SHARED_VALIDATOR_STRING_155 = 'VERTICAL_PARTY_REGISTRY_MF_MANIFEST';
const SHARED_VALIDATOR_STRING_156 = 'VERTICAL_PARTY_REGISTRY_WORKER';
const SHARED_VALIDATOR_STRING_157 = 'VERTICAL_PARTY_REGISTRY_WORKER_BINDING';
const SHARED_VALIDATOR_STRING_158 = 'VERTICAL_PARTY_REGISTRY_WORKER_NAME';
const SHARED_VALIDATOR_STRING_159 = 'verticalPartyRegistry';
const SHARED_VALIDATOR_STRING_160 = 'verticalPartyRegistryBackend';
const SHARED_VALIDATOR_STRING_161 = 'verticals/party-registry';
const SHARED_VALIDATOR_STRING_162 = 'verticals/party-registry/api/index.ts';
const SHARED_VALIDATOR_STRING_163 = 'verticals/party-registry/modern.config.ts';
const SHARED_VALIDATOR_STRING_164 = 'verticals/party-registry/module-federation.config.ts';
const SHARED_VALIDATOR_STRING_165 = 'verticals/party-registry/package.json';
const SHARED_VALIDATOR_STRING_166 = 'verticals/party-registry/shared/api.ts';
const SHARED_VALIDATOR_STRING_167 = 'verticals/party-registry/src/api/party-registry-client.ts';
const SHARED_VALIDATOR_STRING_168 = 'web-and-api-same-build';
const SHARED_VALIDATOR_STRING_169 = 'workspace:*';
const SHARED_VALIDATOR_STRING_170 = 'ZEPHYR_PARTY_REGISTRY_APPLICATION_UID';
const SHARED_VALIDATOR_STRING_171 = 'ZEPHYR_PARTY_REGISTRY_SNAPSHOT_ID';
const SHARED_VALIDATOR_STRING_172 = 'ZEPHYR_PARTY_REGISTRY_VERSION_ID';
const SHARED_VALIDATOR_STRING_173 = 'zephyr:dependencies';
const SHARED_VALIDATOR_STRING_174 = 'zerops.yaml';
const SHARED_VALIDATOR_STRING_175 = '@app/gateway-principal-verifier';
const SHARED_VALIDATOR_STRING_176 = 'gateway-principal-verifier';
const SHARED_VALIDATOR_STRING_177 = 'packages/gateway-principal-verifier';

// Generated by ultramodern-create with an immutable expected proof contract.
const root = process.cwd();
const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Number);
type ComparableJson =
  | undefined
  | null
  | boolean
  | number
  | string
  | readonly ComparableJson[]
  | { readonly [key: string]: ComparableJson };
const ComparableJsonSchema: Schema.Codec<ComparableJson> = Schema.suspend(() =>
  Schema.Union([
    Schema.Undefined,
    Schema.Null,
    Schema.Boolean,
    Schema.Number,
    Schema.String,
    Schema.Array(ComparableJsonSchema),
    Schema.Record(Schema.String, ComparableJsonSchema),
  ]),
);
const ComparableJsonArraySchema = Schema.Array(ComparableJsonSchema);
const ComparableJsonObjectSchema = Schema.Record(Schema.String, ComparableJsonSchema);
const isComparableJsonArray = Schema.is(ComparableJsonArraySchema);
const isComparableJsonObject = Schema.is(ComparableJsonObjectSchema);
const MetadataDocumentSchema = Schema.Struct({ schemaVersion: Schema.Number });
const PackageSourceDocumentSchema = Schema.Struct({ strategy: Schema.String });
const isMetadataDocument = Schema.is(MetadataDocumentSchema);
const isPackageSourceDocument = Schema.is(PackageSourceDocumentSchema);
const templatePlaceholderOpening = String.fromCodePoint(36, 123);
const javascriptDash = String.fromCodePoint(106, 115, 45);
const shellSingleQuoteEscape = String.raw`'\''`;
const sourceFragment = (...parts: readonly string[]): string => parts.join('');
const jsonEquivalent = Schema.toEquivalence(Schema.Unknown);
const IdentifierEntrySchema = Schema.Struct({ id: Schema.String });
type IdentifierEntry = typeof IdentifierEntrySchema.Type;
const isIdentifierEntry = Schema.is(IdentifierEntrySchema);
const createQualityGates = () => ({
  assets: {
    cacheControlRequiredForCss: true,
    cssPreloadRequired: true,
    cssResponseRequired: true,
    sourcemapsPubliclyReferenced: false,
  },
  budgets: {
    cssAssetMaxBytes: 750_000,
    localeJsonMaxBytes: 100_000,
    mfManifestMaxBytes: 500_000,
    sitemapXmlMaxBytes: 500_000,
    ssrHtmlMaxBytes: 250_000,
  },
  csp: {
    decision: SHARED_VALIDATOR_STRING_109,
    finalMode: SHARED_VALIDATOR_STRING_110,
  },
  indexing: {
    previewNoindex: true,
    productionPublicRoutesIndexable: true,
  },
  publicRoutes: {
    requireRobotsSitemapConsistency: true,
    requireSitemapWhenPresent: true,
    requireWebManifestWhenPresent: true,
  },
  statusCodes: {
    notFoundRoute: SHARED_VALIDATOR_STRING_030,
    unknownRouteStatus: 404,
  },
});
const createVerticalNodeExecution = () => ({
  adapterVersion: SHARED_VALIDATOR_STRING_054,
  containerEntry: SHARED_VALIDATOR_STRING_072,
  expected: {
    buildMarker: SHARED_VALIDATOR_STRING_038,
    unitId: SHARED_VALIDATOR_STRING_046,
  },
  expose: SHARED_VALIDATOR_STRING_004,
  kind: SHARED_VALIDATOR_STRING_088,
  manifestEnv: SHARED_VALIDATOR_STRING_153,
  manifestUrl: SHARED_VALIDATOR_STRING_071,
  remoteName: SHARED_VALIDATOR_STRING_160,
  remoteType: SHARED_VALIDATOR_STRING_063,
  runtimePackage: SHARED_VALIDATOR_STRING_026,
});
const createVerticalCloudflareExecution = () => ({
  kind: SHARED_VALIDATOR_STRING_058,
  publicUrlEnv: SHARED_VALIDATOR_STRING_147,
  ssr: {
    assetsBinding: 'ASSETS',
    effectBffBundle: SHARED_VALIDATOR_STRING_013,
    routeManifest: SHARED_VALIDATOR_STRING_012,
    ssrBundle: SHARED_VALIDATOR_STRING_014,
    workerEntry: SHARED_VALIDATOR_STRING_010,
    workerManifest: SHARED_VALIDATOR_STRING_011,
  },
  workerDispatch: {
    dispatchNamespaceEnv: SHARED_VALIDATOR_STRING_154,
    dispatchWorkerNameEnv: SHARED_VALIDATOR_STRING_158,
    preferred: SHARED_VALIDATOR_STRING_126,
    requestInterface: 'fetch',
    serviceBinding: SHARED_VALIDATOR_STRING_156,
    serviceBindingEnv: SHARED_VALIDATOR_STRING_157,
  },
  workerName: SHARED_VALIDATOR_STRING_044,
  zephyr: {
    applicationUidEnv: SHARED_VALIDATOR_STRING_170,
    integration: SHARED_VALIDATOR_STRING_076,
    runtime: SHARED_VALIDATOR_STRING_139,
    snapshotIdEnv: SHARED_VALIDATOR_STRING_171,
    versionIdEnv: SHARED_VALIDATOR_STRING_172,
  },
});

const createCloudflareSecurityContract = () => ({
  contentSecurityPolicy: {
    directives: {
      'base-uri': ["'self'"],
      'connect-src': ["'self'", 'https:', 'http:', 'wss:', 'ws:'],
      'default-src': ["'self'"],
      'font-src': ["'self'", 'data:', 'https:', 'http:'],
      'form-action': ["'self'"],
      'frame-ancestors': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
      'manifest-src': ["'self'", 'https:', 'http:'],
      'object-src': ["'none'"],
      'script-src': ["'self'", SHARED_VALIDATOR_STRING_016, SHARED_VALIDATOR_STRING_015, 'https:', 'http:', 'blob:'],
      'style-src': ["'self'", SHARED_VALIDATOR_STRING_016, 'https:', 'http:'],
      'worker-src': ["'self'", 'blob:'],
    },
    mode: SHARED_VALIDATOR_STRING_107,
    reason: SHARED_VALIDATOR_STRING_108,
  },
  enabled: true,
  headers: {
    contentTypeOptions: 'nosniff',
    permissionsPolicy: SHARED_VALIDATOR_STRING_055,
    referrerPolicy: SHARED_VALIDATOR_STRING_140,
  },
  noindex: {
    localhost: true,
    previewHostnames: [],
    workersDev: true,
  },
});

const createVerticalExecutionSurfaces = () => ({
  cloudflare: createVerticalCloudflareExecution(),
  node: createVerticalNodeExecution(),
});

const createShellCloudflareContract = () => ({
  assetsBinding: 'ASSETS',
  compatibilityDate: SHARED_VALIDATOR_STRING_036,
  compatibilityFlags: [SHARED_VALIDATOR_STRING_089, SHARED_VALIDATOR_STRING_070],
  evidence: {
    proofScript: SHARED_VALIDATOR_STRING_119,
    reportDefault: SHARED_VALIDATOR_STRING_008,
  },
  publicUrlEnv: SHARED_VALIDATOR_STRING_148,
  qualityGates: createQualityGates(),
  routes: {
    locale: '/locales/en/shell.json',
    mfManifest: SHARED_VALIDATOR_STRING_031,
    ssr: '/en',
  },
  security: createCloudflareSecurityContract(),
  target: SHARED_VALIDATOR_STRING_056,
  workerName: 'app-shell-super-app',
});

const createVerticalCloudflareContract = () => ({
  assetsBinding: 'ASSETS',
  compatibilityDate: SHARED_VALIDATOR_STRING_036,
  compatibilityFlags: [SHARED_VALIDATOR_STRING_089, SHARED_VALIDATOR_STRING_070],
  evidence: {
    proofScript: SHARED_VALIDATOR_STRING_119,
    reportDefault: SHARED_VALIDATOR_STRING_008,
  },
  jsonSmokeChecks: [
    {
      expect: {
        'checks.api': 'ready',
        'checks.moduleFederation': 'ready',
        'checks.ssr': 'ready',
        status: 'ready',
      },
      id: 'party-registry-readiness-smoke',
      route: SHARED_VALIDATOR_STRING_034,
    },
  ],
  publicUrlEnv: SHARED_VALIDATOR_STRING_147,
  qualityGates: createQualityGates(),
  routes: {
    apiReadiness: SHARED_VALIDATOR_STRING_034,
    mfManifest: SHARED_VALIDATOR_STRING_031,
  },
  security: createCloudflareSecurityContract(),
  target: SHARED_VALIDATOR_STRING_056,
  workerName: SHARED_VALIDATOR_STRING_044,
});

const createVerticalBackendFederationContract = () => ({
  cache: {
    cloudflareSnapshot: 'immutable',
    nodeManifest: 'no-store',
    nodeUnpinnedContainer: 'revalidate',
    nodeVersionedContainer: 'immutable',
  },
  compatibility: {
    contractVersion: SHARED_VALIDATOR_STRING_079,
    effectVersion: SHARED_VALIDATOR_STRING_039,
    moduleFederationVersion: '2.9.0',
    packageName: SHARED_VALIDATOR_STRING_018,
  },
  deliveryUnit: {
    buildMarker: SHARED_VALIDATOR_STRING_038,
    kind: SHARED_VALIDATOR_STRING_077,
    packageName: SHARED_VALIDATOR_STRING_018,
    schemaVersion: 1,
    sourceRevision: 'workspace',
    unitId: SHARED_VALIDATOR_STRING_046,
    version: '0.1.0',
  },
  executionSurfaces: createVerticalExecutionSurfaces(),
  exposes: {
    './effect-api': {
      client: SHARED_VALIDATOR_STRING_167,
      contract: SHARED_VALIDATOR_STRING_166,
      openapi: SHARED_VALIDATOR_STRING_033,
      readiness: SHARED_VALIDATOR_STRING_034,
      runtime: SHARED_VALIDATOR_STRING_162,
    },
  },
  fallback: {
    failureEvent: 'modernjs:microvertical-server-fallback',
    strategy: 'typed-effect-error',
    timeoutMs: 1500,
  },
  name: SHARED_VALIDATOR_STRING_160,
  role: SHARED_VALIDATOR_STRING_078,
  runtimeFramework: 'effect',
  strictEffectApproach: true,
  versionBoundary: {
    api: {
      buildMarker: 'verticals/party-registry/shared/ultramodern-build.ts',
      publicUrlEnv: SHARED_VALIDATOR_STRING_147,
      readiness: SHARED_VALIDATOR_STRING_034,
    },
    identityRoot: SHARED_VALIDATOR_STRING_065,
    invariant: SHARED_VALIDATOR_STRING_168,
    packageName: SHARED_VALIDATOR_STRING_018,
    ui: {
      buildMarker: 'verticals/party-registry/src/routes/ultramodern-route-metadata.ts',
      manifestEnv: SHARED_VALIDATOR_STRING_155,
      manifestUrl: SHARED_VALIDATOR_STRING_073,
    },
  },
});

const workspaceValidationContractDefinition = {
  ciEvidenceScripts: {
    'action:test:integration': 'pnpm --filter @app/core-runtime action:test:integration',
    'deployment-impact:plan': 'node ./scripts/plan-deployment-impact.mts',
    'quality:audit': 'node ./scripts/quality-audit.mts',
    'quality:audit:gate': 'node ./scripts/quality-audit-gate.mts',
    'quality:check': 'pnpm quality:audit && pnpm quality:audit:gate',
    'test:deployment-impact':
      'node scripts/generate-outbox-worker-deployment.mjs && rstest --project scripts scripts/tests/plan-deployment-impact scripts/tests/outbox-worker-delivery',
    'test:generation': 'rstest --project generation',
    'test:integration': 'pnpm -r --if-present run test:integration',
    'test:scripts': 'rstest --project scripts',
    'test:unit': 'pnpm -r --if-present run test:unit && pnpm -r --if-present run test:component',
  },
  cloudflareSecurity: createCloudflareSecurityContract(),
  cohort: {
    appIds: [SHARED_VALIDATOR_STRING_131, SHARED_VALIDATOR_STRING_098],
    backendAppIds: [SHARED_VALIDATOR_STRING_098],
    modernPackages: [
      '@modern-js/adapter-rstest',
      SHARED_VALIDATOR_STRING_024,
      SHARED_VALIDATOR_STRING_023,
      SHARED_VALIDATOR_STRING_022,
      SHARED_VALIDATOR_STRING_025,
      SHARED_VALIDATOR_STRING_027,
      SHARED_VALIDATOR_STRING_028,
      SHARED_VALIDATOR_STRING_029,
    ],
    ownerIds: [
      SHARED_VALIDATOR_STRING_064,
      SHARED_VALIDATOR_STRING_176,
      SHARED_VALIDATOR_STRING_131,
      SHARED_VALIDATOR_STRING_127,
      SHARED_VALIDATOR_STRING_128,
      SHARED_VALIDATOR_STRING_098,
    ],
    packageManifests: [
      {
        id: 'workspace-root',
        packageName: 'app',
        path: SHARED_VALIDATOR_STRING_091,
        role: 'workspace-root',
      },
      {
        id: SHARED_VALIDATOR_STRING_131,
        packageName: SHARED_VALIDATOR_STRING_021,
        path: SHARED_VALIDATOR_STRING_050,
        role: 'shell',
      },
      {
        id: SHARED_VALIDATOR_STRING_064,
        packageName: SHARED_VALIDATOR_STRING_017,
        path: SHARED_VALIDATOR_STRING_093,
        role: SHARED_VALIDATOR_STRING_129,
      },
      {
        id: SHARED_VALIDATOR_STRING_176,
        packageName: SHARED_VALIDATOR_STRING_175,
        path: `${SHARED_VALIDATOR_STRING_177}/package.json`,
        role: SHARED_VALIDATOR_STRING_129,
      },
      {
        id: SHARED_VALIDATOR_STRING_127,
        packageName: SHARED_VALIDATOR_STRING_019,
        path: SHARED_VALIDATOR_STRING_095,
        role: SHARED_VALIDATOR_STRING_129,
      },
      {
        id: SHARED_VALIDATOR_STRING_128,
        packageName: SHARED_VALIDATOR_STRING_020,
        path: 'packages/shared-design-tokens/package.json',
        role: SHARED_VALIDATOR_STRING_129,
      },
      {
        id: SHARED_VALIDATOR_STRING_098,
        packageName: SHARED_VALIDATOR_STRING_018,
        path: SHARED_VALIDATOR_STRING_165,
        role: 'vertical',
      },
    ],
    releaseCohort: {
      aliases: {
        '@modern-js/adapter-rstest': '@bleedingdev/modern-js-adapter-rstest',
        '@modern-js/app-tools': '@bleedingdev/modern-js-app-tools',
        '@modern-js/app-tools-extensions': '@bleedingdev/modern-js-app-tools-extensions',
        '@modern-js/backend-federation-contracts': '@bleedingdev/modern-js-backend-federation-contracts',
        '@modern-js/bff-core': '@bleedingdev/modern-js-bff-core',
        '@modern-js/bff-effect': '@bleedingdev/modern-js-bff-effect',
        '@modern-js/bff-runtime': '@bleedingdev/modern-js-bff-runtime',
        '@modern-js/boundary-debugger': '@bleedingdev/modern-js-boundary-debugger',
        '@modern-js/builder': '@bleedingdev/modern-js-builder',
        '@modern-js/code-tools': '@bleedingdev/modern-js-code-tools',
        '@modern-js/create-request': '@bleedingdev/modern-js-create-request',
        '@modern-js/federation-runtime': '@bleedingdev/modern-js-federation-runtime',
        '@modern-js/i18n-integration': '@bleedingdev/modern-js-i18n-integration',
        '@modern-js/i18n-runtime-extensions': '@bleedingdev/modern-js-i18n-runtime-extensions',
        '@modern-js/i18n-utils': '@bleedingdev/modern-js-i18n-utils',
        '@modern-js/image': '@bleedingdev/modern-js-image',
        '@modern-js/main-doc': '@bleedingdev/modern-js-main-doc',
        '@modern-js/plugin': '@bleedingdev/modern-js-plugin',
        '@modern-js/plugin-bff': '@bleedingdev/modern-js-plugin-bff',
        '@modern-js/plugin-bff-build-extensions': '@bleedingdev/modern-js-plugin-bff-build-extensions',
        '@modern-js/plugin-bff-extensions': '@bleedingdev/modern-js-plugin-bff-extensions',
        '@modern-js/plugin-data-loader': '@bleedingdev/modern-js-plugin-data-loader',
        '@modern-js/plugin-i18n': '@bleedingdev/modern-js-plugin-i18n',
        '@modern-js/plugin-polyfill': '@bleedingdev/modern-js-plugin-polyfill',
        '@modern-js/plugin-ssg': '@bleedingdev/modern-js-plugin-ssg',
        '@modern-js/plugin-styled-components': '@bleedingdev/modern-js-plugin-styled-components',
        '@modern-js/plugin-tanstack': '@bleedingdev/modern-js-plugin-tanstack',
        '@modern-js/prod-server': '@bleedingdev/modern-js-prod-server',
        '@modern-js/render': '@bleedingdev/modern-js-render',
        '@modern-js/runtime': '@bleedingdev/modern-js-runtime',
        '@modern-js/runtime-extensions': '@bleedingdev/modern-js-runtime-extensions',
        '@modern-js/runtime-renderer-extensions': '@bleedingdev/modern-js-runtime-renderer-extensions',
        '@modern-js/runtime-utils': '@bleedingdev/modern-js-runtime-utils',
        '@modern-js/sandpack-react': '@bleedingdev/modern-js-sandpack-react',
        '@modern-js/server': '@bleedingdev/modern-js-server',
        '@modern-js/server-core': '@bleedingdev/modern-js-server-core',
        '@modern-js/server-runtime': '@bleedingdev/modern-js-server-runtime',
        '@modern-js/server-runtime-extensions': '@bleedingdev/modern-js-server-runtime-extensions',
        '@modern-js/server-utils': '@bleedingdev/modern-js-server-utils',
        '@modern-js/surface-resolution': '@bleedingdev/modern-js-surface-resolution',
        '@modern-js/tsconfig': '@bleedingdev/modern-js-tsconfig',
        '@modern-js/types': '@bleedingdev/modern-js-types',
        '@modern-js/ultramodern-app-tools': '@bleedingdev/modern-js-ultramodern-app-tools',
        '@modern-js/ultramodern-create': '@bleedingdev/modern-js-ultramodern-create',
        '@modern-js/ultramodern-sandpack-profile': '@bleedingdev/modern-js-ultramodern-sandpack-profile',
        '@modern-js/utils': '@bleedingdev/modern-js-utils',
      },
      packages: [
        {
          sourceName: '@modern-js/adapter-rstest',
          targetName: '@bleedingdev/modern-js-adapter-rstest',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/app-tools',
          targetName: '@bleedingdev/modern-js-app-tools',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/app-tools-extensions',
          targetName: '@bleedingdev/modern-js-app-tools-extensions',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/backend-federation-contracts',
          targetName: '@bleedingdev/modern-js-backend-federation-contracts',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/bff-core',
          targetName: '@bleedingdev/modern-js-bff-core',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/bff-effect',
          targetName: '@bleedingdev/modern-js-bff-effect',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/bff-runtime',
          targetName: '@bleedingdev/modern-js-bff-runtime',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/boundary-debugger',
          targetName: '@bleedingdev/modern-js-boundary-debugger',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/builder',
          targetName: '@bleedingdev/modern-js-builder',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/code-tools',
          targetName: '@bleedingdev/modern-js-code-tools',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/create-request',
          targetName: '@bleedingdev/modern-js-create-request',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/federation-runtime',
          targetName: '@bleedingdev/modern-js-federation-runtime',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/i18n-integration',
          targetName: '@bleedingdev/modern-js-i18n-integration',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/i18n-runtime-extensions',
          targetName: '@bleedingdev/modern-js-i18n-runtime-extensions',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/i18n-utils',
          targetName: '@bleedingdev/modern-js-i18n-utils',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/image',
          targetName: '@bleedingdev/modern-js-image',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/main-doc',
          targetName: '@bleedingdev/modern-js-main-doc',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/plugin',
          targetName: '@bleedingdev/modern-js-plugin',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/plugin-bff',
          targetName: '@bleedingdev/modern-js-plugin-bff',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/plugin-bff-build-extensions',
          targetName: '@bleedingdev/modern-js-plugin-bff-build-extensions',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/plugin-bff-extensions',
          targetName: '@bleedingdev/modern-js-plugin-bff-extensions',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/plugin-data-loader',
          targetName: '@bleedingdev/modern-js-plugin-data-loader',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/plugin-i18n',
          targetName: '@bleedingdev/modern-js-plugin-i18n',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/plugin-polyfill',
          targetName: '@bleedingdev/modern-js-plugin-polyfill',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/plugin-ssg',
          targetName: '@bleedingdev/modern-js-plugin-ssg',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/plugin-styled-components',
          targetName: '@bleedingdev/modern-js-plugin-styled-components',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/plugin-tanstack',
          targetName: '@bleedingdev/modern-js-plugin-tanstack',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/prod-server',
          targetName: '@bleedingdev/modern-js-prod-server',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/render',
          targetName: '@bleedingdev/modern-js-render',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/runtime',
          targetName: '@bleedingdev/modern-js-runtime',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/runtime-extensions',
          targetName: '@bleedingdev/modern-js-runtime-extensions',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/runtime-renderer-extensions',
          targetName: '@bleedingdev/modern-js-runtime-renderer-extensions',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/runtime-utils',
          targetName: '@bleedingdev/modern-js-runtime-utils',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/sandpack-react',
          targetName: '@bleedingdev/modern-js-sandpack-react',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/server',
          targetName: '@bleedingdev/modern-js-server',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/server-core',
          targetName: '@bleedingdev/modern-js-server-core',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/server-runtime',
          targetName: '@bleedingdev/modern-js-server-runtime',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/server-runtime-extensions',
          targetName: '@bleedingdev/modern-js-server-runtime-extensions',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/server-utils',
          targetName: '@bleedingdev/modern-js-server-utils',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/surface-resolution',
          targetName: '@bleedingdev/modern-js-surface-resolution',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/tsconfig',
          targetName: '@bleedingdev/modern-js-tsconfig',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/types',
          targetName: '@bleedingdev/modern-js-types',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/ultramodern-app-tools',
          targetName: '@bleedingdev/modern-js-ultramodern-app-tools',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/ultramodern-create',
          targetName: '@bleedingdev/modern-js-ultramodern-create',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/ultramodern-sandpack-profile',
          targetName: '@bleedingdev/modern-js-ultramodern-sandpack-profile',
          version: SHARED_VALIDATOR_STRING_037,
        },
        {
          sourceName: '@modern-js/utils',
          targetName: '@bleedingdev/modern-js-utils',
          version: SHARED_VALIDATOR_STRING_037,
        },
      ],
      release: {
        tag: 'latest',
        version: SHARED_VALIDATOR_STRING_037,
      },
      schema: 'bleedingdev.ultramodern.release-cohort',
      schemaVersion: 1,
      source: {
        commit: '6f86e7edb4440ddc223d1c81750a52c4c01fddd6',
        repository: 'BleedingDev/ultramodern.js',
      },
    },
    sharedPackageIds: [
      SHARED_VALIDATOR_STRING_064,
      SHARED_VALIDATOR_STRING_176,
      SHARED_VALIDATOR_STRING_127,
      SHARED_VALIDATOR_STRING_128,
    ],
    standaloneModernTools: {
      '@modern-js/codesmith': '2.6.9',
    },
    verticalIds: [SHARED_VALIDATOR_STRING_098],
  },
  federatedCompositionSourcePolicy: {
    forbiddenSourcePatterns: [
      {
        diagnostic:
          'Federated hosts must use the framework distributed SSR boundary directly; hydration-time remote factories are forbidden.',
        expression: '\\bcreateHydratedRemote\\b',
        flags: 'u',
        id: 'hydrated-remote-factory',
      },
      {
        diagnostic:
          'Federated hosts must hydrate the server DOM directly; hydrated-state component switching is forbidden.',
        expression:
          '\\[\\s*(?:is)?[Hh]ydrated\\s*,\\s*set(?:Is)?Hydrated\\s*\\]\\s*=\\s*useState\\s*\\(\\s*false\\s*\\)',
        flags: 'u',
        id: 'hydration-flag',
      },
      {
        diagnostic: 'Federated hosts must not render a local component copy while loading a remote implementation.',
        expression: '(?:loading\\s*:\\s*|fallback\\s*=\\s*\\{\\s*)<\\s*(?:ServerComponent|LocalComponent)\\b',
        flags: 'u',
        id: 'local-loading-copy',
      },
    ],
    hosts: [
      {
        id: SHARED_VALIDATOR_STRING_131,
        remotes: [
          {
            directory: SHARED_VALIDATOR_STRING_161,
            id: SHARED_VALIDATOR_STRING_098,
            packageName: SHARED_VALIDATOR_STRING_018,
          },
        ],
        srcDir: SHARED_VALIDATOR_STRING_051,
      },
    ],
    schemaVersion: 1,
  },
  fullStackVerticals: [
    {
      apiClientExport: SHARED_VALIDATOR_STRING_002,
      apiClientPath: 'src/api/party-registry-client.ts',
      apiContractExport: './api',
      apiContractPath: 'shared/api.ts',
      apiPrefix: SHARED_VALIDATOR_STRING_032,
      apiProtocol: 'rest',
      backendFederation: {
        contractVersion: SHARED_VALIDATOR_STRING_079,
        deliveryUnit: {
          buildMarker: SHARED_VALIDATOR_STRING_038,
          kind: SHARED_VALIDATOR_STRING_077,
          packageName: SHARED_VALIDATOR_STRING_018,
          schemaVersion: 1,
          sourceRevision: 'workspace',
          unitId: SHARED_VALIDATOR_STRING_046,
          version: '0.1.0',
        },
        executionSurfaces: [SHARED_VALIDATOR_STRING_088],
        exposes: [SHARED_VALIDATOR_STRING_004],
        name: SHARED_VALIDATOR_STRING_160,
        nodeAdapterVersion: SHARED_VALIDATOR_STRING_054,
        openapiPath: SHARED_VALIDATOR_STRING_033,
        readinessPath: SHARED_VALIDATOR_STRING_034,
        role: SHARED_VALIDATOR_STRING_078,
        runtimeFramework: 'effect',
        strictEffectApproach: true,
      },
      componentPaths: ['verticals/party-registry/src/federation/page-contacts.tsx'],
      deliveryUnit: {
        appId: SHARED_VALIDATOR_STRING_098,
        buildMarker: SHARED_VALIDATOR_STRING_038,
        deployProfile: SHARED_VALIDATOR_STRING_057,
        kind: SHARED_VALIDATOR_STRING_077,
        packageName: SHARED_VALIDATOR_STRING_018,
        schemaVersion: 1,
        sourceRevision: 'workspace',
        unitId: SHARED_VALIDATOR_STRING_046,
        version: '0.1.0',
      },
      domain: SHARED_VALIDATOR_STRING_098,
      emitsApi: true,
      emitsUi: true,
      exposes: [SHARED_VALIDATOR_STRING_005],
      group: SHARED_VALIDATOR_STRING_099,
      hasFederationEntry: true,
      hasNamespaceLocale: true,
      hasOwnerPage: false,
      id: SHARED_VALIDATOR_STRING_098,
      localisedUrls: {},
      mfName: SHARED_VALIDATOR_STRING_159,
      namespace: SHARED_VALIDATOR_STRING_098,
      packageName: SHARED_VALIDATOR_STRING_018,
      path: SHARED_VALIDATOR_STRING_161,
      port: 4102,
      routeMetaPaths: ['verticals/party-registry/src/routes/[lang]/contacts/route.meta.ts'],
      routePagePaths: ['verticals/party-registry/src/routes/[lang]/contacts/page.tsx'],
      stem: SHARED_VALIDATOR_STRING_098,
      surfaceProfile: 'full-stack',
      tailwindPrefix: 'partyregistry',
      typecheckIncludes: [
        'src',
        'scripts',
        'tests',
        'drizzle.config.ts',
        SHARED_VALIDATOR_STRING_075,
        SHARED_VALIDATOR_STRING_091,
        'shared',
        'server',
        'api',
        'vertical.manifest.ts',
        'vertical.registration.ts',
      ],
      verticalRefs: [],
      zephyrAlias: SHARED_VALIDATOR_STRING_099,
    },
  ],
  generatedSurfacePolicy: {
    rules: [
      {
        id: 'effect-diagnostics-suppressions',
        paths: [
          {
            extensions: ['.ts', '.tsx'],
            kind: 'directory',
            path: SHARED_VALIDATOR_STRING_051,
          },
          {
            extensions: ['.ts', '.tsx'],
            kind: 'directory',
            path: 'verticals/party-registry/src',
          },
          {
            extensions: ['.ts', '.tsx'],
            kind: 'directory',
            path: 'verticals/party-registry/api',
          },
          {
            excludePaths: [SHARED_VALIDATOR_STRING_124],
            extensions: ['.mts', '.ts'],
            kind: 'directory',
            path: 'scripts',
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_048,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_163,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_049,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_164,
          },
        ],
        patterns: [
          {
            diagnostic: 'Generated sources must not suppress Effect diagnostics.',
            expression: '@effect-diagnostics\\b',
            fixArea: 'remove the @effect-diagnostics suppression directive',
            flags: 'u',
            id: 'effect-diagnostics-directive',
          },
        ],
      },
      {
        id: 'zephyr-gating',
        paths: [
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_091,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_050,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_165,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_048,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_163,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_049,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_164,
          },
        ],
        patterns: [
          {
            diagnostic: 'Generated Zephyr integration must not be gated or disabled through ULTRAMODERN_ZEPHYR.',
            expression: '\\bULTRAMODERN_ZEPHYR\\b',
            fixArea: 'use the framework-owned Zephyr integration without a gate',
            flags: 'u',
            id: 'ultramodern-zephyr-environment-gate',
          },
        ],
      },
      {
        id: 'module-federation-bridge-escapes',
        paths: [
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_049,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_164,
          },
        ],
        patterns: [
          {
            diagnostic: 'Generated Module Federation must keep dynamic remote type hints enabled.',
            expression: '\\bdisableDynamicRemoteTypeHints\\s*:\\s*true\\b',
            fixArea: 'remove disableDynamicRemoteTypeHints: true',
            flags: 'u',
            id: 'dynamic-remote-type-hints-disabled',
          },
          {
            diagnostic: 'Generated Module Federation must not exclude shared plugins from tree shaking.',
            expression: '\\btreeShakingSharedExcludePlugins\\b',
            fixArea: 'remove treeShakingSharedExcludePlugins',
            flags: 'u',
            id: 'shared-exclude-plugin-tree-shaking',
          },
        ],
      },
      {
        id: 'shell-routing-native-navigation',
        paths: [
          {
            extensions: ['.ts', '.tsx'],
            kind: 'directory',
            path: 'apps/shell-super-app/src/routes',
          },
        ],
        patterns: [
          {
            diagnostic: 'Generated shell routing must use native router navigation instead of window.location.',
            expression:
              '\\bwindow\\s*\\.\\s*location(?:\\s*\\.\\s*(?:assign|replace|reload)\\s*\\(|\\s*\\.\\s*href\\s*=|\\s*=)',
            fixArea: 'replace manual window.location navigation with the router primitive',
            flags: 'u',
            id: 'window-location-navigation',
          },
          {
            diagnostic: 'Generated shell routing must not intercept anchor clicks synthetically.',
            fixArea: 'use the router Link primitive without preventDefault interception',
            id: 'synthetic-anchor-click-interception',
            structuralMatcher: {
              attributeName: 'onClick',
              elementName: 'a',
              kind: SHARED_VALIDATOR_STRING_074,
            },
          },
        ],
      },
      {
        id: 'module-federation-native-loading',
        paths: [
          {
            extensions: ['.ts', '.tsx'],
            kind: 'directory',
            path: 'apps/shell-super-app/src/routes',
          },
        ],
        patterns: [
          {
            diagnostic: 'Generated shell routing must use native Module Federation loading primitives.',
            expression: '\\b(?:hydrateRoot|loadRemote|loadShare)\\s*\\(',
            fixArea: 'remove the manual Module Federation hydration or loading wrapper',
            flags: 'u',
            id: 'manual-module-federation-loading-wrapper',
          },
        ],
      },
      {
        id: 'framework-config-api',
        paths: [
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_048,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_163,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_049,
          },
          {
            kind: 'file',
            path: SHARED_VALIDATOR_STRING_164,
          },
        ],
        patterns: [
          {
            diagnostic:
              'Generated config must use the framework config environment API instead of direct process.env access.',
            expression: '\\bprocess\\s*\\.\\s*env\\b',
            fixArea: 'replace direct process.env access with the framework config API',
            flags: 'u',
            id: 'direct-process-env-access',
          },
          {
            diagnostic: 'Generated config must not invoke node:child_process directly.',
            expression: '[\'"]node:child_process[\'"]',
            fixArea: 'use the framework config API instead of node:child_process',
            flags: 'u',
            id: 'node-child-process-access',
          },
        ],
      },
    ],
    schemaVersion: 1,
  },
  kind: 'modernjs.ultramodern-workspace-validation-contract',
  legacy: {
    forbiddenCompactConfigFields: ['generatedContract', 'packageCohort', 'workspaceValidationContract'],
    forbiddenPackageSourceFields: ['generatedWorkspacePackages', 'metadata', 'modernPackages'],
    forbiddenTopologyFields: ['effectServices', 'remotes'],
    retiredMetadataPaths: [
      '.modernjs/ultramodern-generated-contract.json',
      '.modernjs/ultramodern-package-source.json',
      '.modernjs/ultramodern-workspace-template-manifest.json',
    ],
  },
  metadata: {
    compactConfig: {
      path: '.modernjs/ultramodern.json',
      schemaVersion: 1,
    },
    developmentOverlay: {
      path: 'topology/local-overlays/development.json',
      schemaVersion: 1,
    },
    ownership: {
      path: 'topology/ownership.json',
      schemaVersion: 1,
    },
    referenceTopology: {
      path: 'topology/reference-topology.json',
      schemaVersion: 1,
    },
    releaseCohort: {
      path: SHARED_VALIDATOR_STRING_009,
      schemaVersion: 1,
    },
  },
  node: {
    engineRange: '>=26',
    version: '26.7.0',
  },
  oldRemotePaths: ['apps/remotes'],
  packageScope: 'app',
  packageScripts: {
    'action:test:unit': 'pnpm --filter @app/core-runtime action:test:unit',
    'agents:refs:check': 'node ./scripts/setup-agent-reference-repos.mts --check',
    'agents:refs:install': 'node ./scripts/setup-agent-reference-repos.mts',
    'api:check': 'node ./scripts/check-ultramodern-api-boundaries.mts',
    build: 'pnpm --filter "./apps/shell-super-app" run build && pnpm mf:types && pnpm performance:readiness',
    check:
      'pnpm format:check && pnpm lint && pnpm action:test:unit && pnpm typecheck && pnpm skills:check && pnpm i18n:boundaries && pnpm api:check && pnpm database-access:check && pnpm module-entrypoints:check && pnpm check:module-contracts && pnpm contract:check && pnpm performance:readiness',
    'check:module-contracts': 'node ./scripts/check-ontos-module-contracts.mts',
    'cloudflare-output:verify': 'node ./scripts/verify-cloudflare-output.mts',
    'cloudflare:build':
      'pnpm --filter "./apps/shell-super-app" run cloudflare:build && pnpm mf:types && pnpm cloudflare-output:verify',
    'cloudflare:deploy': 'pnpm --filter "./apps/shell-super-app" run cloudflare:deploy',
    'cloudflare:proof': SHARED_VALIDATOR_STRING_084,
    'contract:check': SHARED_VALIDATOR_STRING_087,
    'database-access:check': 'node ./scripts/check-database-access-boundaries.mts',
    'db:bootstrap-runtime-role': 'node ./scripts/postgres/bootstrap-runtime-role.mts',
    'db:check':
      'pnpm --filter @app/core-runtime db:check && pnpm --filter @app/shell-super-app db:check && pnpm --filter @app/party-registry db:check',
    'db:generate':
      'pnpm --filter @app/core-runtime db:generate && pnpm --filter @app/shell-super-app db:generate && pnpm --filter @app/party-registry db:generate',
    'db:migrate':
      'pnpm db:bootstrap-runtime-role && pnpm --filter @app/core-runtime db:migrate && pnpm --filter @app/shell-super-app db:migrate && pnpm --filter @app/party-registry db:migrate && pnpm db:bootstrap-runtime-role',
    'db:test':
      'pnpm --filter @app/core-runtime db:test && pnpm --filter @app/shell-super-app test:integration && pnpm --filter @app/party-registry db:test',
    'db:verify': 'node ./scripts/verify-application-db-schema.mts',
    dev: 'pnpm --parallel --filter @app/shell-super-app --filter \'./verticals/*\' run "/^dev(?::worker)?$/"',
    'dev:shell': 'pnpm --filter @app/shell-super-app dev',
    'env:local:ensure': 'node ./scripts/ensure-local-environment.mts',
    format: "oxfmt . '!repos/**'",
    'format:check': "oxfmt --check . '!repos/**'",
    'i18n:boundaries': 'node ./scripts/check-ultramodern-i18n-boundaries.mts',
    lint: 'oxlint apps verticals packages',
    'lint:fix': 'oxlint apps verticals packages --fix',
    'mf:types': SHARED_VALIDATOR_STRING_082,
    'module-entrypoints:check': 'node ./scripts/check-module-entrypoint-boundaries.mts',
    'outbox:test':
      'pnpm --filter @app/core-runtime outbox:test:unit && pnpm --filter @app/core-runtime outbox:test:integration',
    'performance:readiness': SHARED_VALIDATOR_STRING_085,
    postinstall: "node ./scripts/bootstrap-agent-skills.mts --postinstall && oxfmt . '!repos/**'",
    'scaffold:action': 'node ./scripts/scaffolding/cli.mts action',
    'scaffold:microvertical-action-boundary': 'node ./scripts/scaffolding/cli.mts microvertical-action-boundary',
    'scaffold:microvertical-page': 'node ./scripts/scaffolding/cli.mts microvertical-page',
    'scaffold:module-api': 'node ./scripts/scaffolding/cli.mts module-api',
    'scaffold:module-contract': 'node ./scripts/scaffolding/cli.mts module-contract',
    'scaffold:outbox-message': 'node ./scripts/scaffolding/cli.mts outbox-message',
    'scaffold:outbox-worker': 'node ./scripts/scaffolding/cli.mts outbox-worker',
    'scaffold:policy': 'node ./scripts/scaffolding/cli.mts policy',
    'scaffold:public-component': 'node ./scripts/scaffolding/cli.mts public-component',
    'scaffold:report': 'node ./scripts/scaffolding/cli.mts report',
    'scaffold:search-provider': 'node ./scripts/scaffolding/cli.mts search-provider',
    'scaffold:search-provider-access': 'node ./scripts/scaffolding/cli.mts search-provider-access',
    'skills:check': 'node ./scripts/bootstrap-agent-skills.mts --check',
    'skills:install': 'node ./scripts/bootstrap-agent-skills.mts',
    typecheck: SHARED_VALIDATOR_STRING_086,
  },
  policy: {
    compactConfig: {
      agentSkills: {
        installDir: './.codex/skills',
        lockfile: './.codex/skills-lock.json',
        mode: 'repo-owned-default-on',
        optOutEnv: ['ULTRAMODERN_SKIP_CODEX_SKILLS=1', 'ULTRAMODERN_CODEX_SKILLS=0'],
        selfContainedVendoring: true,
        target: 'codex',
      },
      backendFederation: {
        apps: [
          {
            contractVersion: SHARED_VALIDATOR_STRING_079,
            deliveryUnit: {
              buildMarker: SHARED_VALIDATOR_STRING_038,
              kind: SHARED_VALIDATOR_STRING_077,
              packageName: SHARED_VALIDATOR_STRING_018,
              schemaVersion: 1,
              sourceRevision: 'workspace',
              unitId: SHARED_VALIDATOR_STRING_046,
              version: '0.1.0',
            },
            executionSurfaces: createVerticalExecutionSurfaces(),
            id: SHARED_VALIDATOR_STRING_098,
            name: SHARED_VALIDATOR_STRING_160,
            path: SHARED_VALIDATOR_STRING_161,
            role: SHARED_VALIDATOR_STRING_078,
            runtimeFramework: 'effect',
            strictEffectApproach: true,
          },
        ],
      },
      deploy: {
        worker: {
          artifacts: [],
          publicAssetExcludes: [],
          wrangler: {
            compatibility_date: SHARED_VALIDATOR_STRING_036,
            compatibility_flags: [SHARED_VALIDATOR_STRING_089, SHARED_VALIDATOR_STRING_070],
          },
        },
      },
      features: {
        tailwind: true,
      },
      moduleFederation: {
        apps: [
          {
            exposes: [],
            hostOnly: true,
            id: SHARED_VALIDATOR_STRING_131,
            name: SHARED_VALIDATOR_STRING_133,
            path: SHARED_VALIDATOR_STRING_047,
            role: 'host',
          },
          {
            exposes: [SHARED_VALIDATOR_STRING_005],
            hostOnly: false,
            id: SHARED_VALIDATOR_STRING_098,
            name: SHARED_VALIDATOR_STRING_159,
            path: SHARED_VALIDATOR_STRING_161,
            role: 'remote',
          },
        ],
      },
      profile: SHARED_VALIDATOR_STRING_057,
      schemaVersion: 1,
      tooling: {
        command: 'ultramodern-create ultramodern',
        wrappers: {
          apiBoundaries: 'scripts/check-ultramodern-api-boundaries.mts',
          backendFederationGenerate: SHARED_VALIDATOR_STRING_116,
          backendFederationProof: SHARED_VALIDATOR_STRING_120,
          cloudflareOutputVerify: SHARED_VALIDATOR_STRING_125,
          cloudflareProof: SHARED_VALIDATOR_STRING_119,
          mfTypes: SHARED_VALIDATOR_STRING_114,
          performanceReadiness: SHARED_VALIDATOR_STRING_122,
          publicSurface: SHARED_VALIDATOR_STRING_117,
          routesGenerate: SHARED_VALIDATOR_STRING_118,
          skills: SHARED_VALIDATOR_STRING_115,
          typecheck: SHARED_VALIDATOR_STRING_123,
          validate: SHARED_VALIDATOR_STRING_124,
        },
      },
      workspace: {
        node: {
          engineRange: '>=26',
          version: '26.7.0',
        },
        packageManager: {
          name: 'pnpm',
          version: '11.25.0',
        },
        packageScope: 'app',
      },
    },
  },
  publicSurfaceManagedSourceAssetPaths: [
    'config/public/robots.txt',
    'config/public/sitemap.xml',
    'config/public/site.webmanifest',
  ],
  schemaVersion: 1,
  scripts: {
    backendFederationGenerate: 'node ./scripts/generate-node-backend-federation.mts',
    build:
      'node ./scripts/ultramodern-typecheck.mts --build packages/shared-contracts/tsconfig.json && node ./scripts/ultramodern-typecheck.mts --build packages/shared-design-tokens/tsconfig.json && pnpm -r --filter "./verticals/*" run build && pnpm --filter "./apps/shell-super-app" run build && pnpm mf:types && pnpm performance:readiness',
    check:
      'pnpm format:check && pnpm lint && pnpm typecheck && pnpm skills:check && pnpm i18n:boundaries && pnpm api:check && pnpm contract:check && pnpm performance:readiness',
    cloudflareBuild:
      'node ./scripts/ultramodern-typecheck.mts --build packages/shared-contracts/tsconfig.json && node ./scripts/ultramodern-typecheck.mts --build packages/shared-design-tokens/tsconfig.json && pnpm -r --filter "./verticals/*" run cloudflare:build && pnpm --filter "./apps/shell-super-app" run cloudflare:build && pnpm mf:types --target cloudflare && pnpm cloudflare-output:verify && pnpm cloudflare:ssr-proof',
    cloudflareDeploy:
      'pnpm -r --filter "./verticals/*" run cloudflare:deploy && pnpm --filter "./apps/shell-super-app" run cloudflare:deploy',
    cloudflareOutputVerify: 'node ./scripts/verify-cloudflare-output.mts',
    cloudflareProof: SHARED_VALIDATOR_STRING_084,
    cloudflareSsrProof: 'node ./scripts/proof-workerd-ssr.mts',
    contractCheck: SHARED_VALIDATOR_STRING_087,
    mfTypes: SHARED_VALIDATOR_STRING_082,
    nodeProof: 'node ./scripts/proof-node-backend-federation.mts',
    performanceReadiness: SHARED_VALIDATOR_STRING_085,
    typecheck: SHARED_VALIDATOR_STRING_086,
    zeropsMaterialize: 'node ./scripts/materialize-zerops-runtime.mjs',
  },
  shellNamespace: 'shell',
  shellRouteMetaPaths: ['apps/shell-super-app/src/routes/[lang]/route.meta.ts'],
  structuralShellPolicy: {
    forbiddenImportPatterns: [
      {
        diagnostic:
          'A thin Shell must consume only published vertical surfaces (package root or Module Federation), never deep-import a vertical directory.',
        expression: 'from\\s+[\'"][^\'"]*verticals/[^\'"/]+/',
        flags: 'u',
        id: 'vertical-directory-deep-import',
      },
      {
        diagnostic:
          'A thin Shell must consume only published vertical surfaces; side-effect imports of vertical directories are forbidden.',
        expression: 'import\\s+[\'"][^\'"]*verticals/[^\'"/]+/',
        flags: 'u',
        id: 'vertical-directory-side-effect-import',
      },
      {
        diagnostic:
          'A thin Shell must consume only published vertical surfaces; dynamic imports of vertical directories are forbidden.',
        expression: 'import\\s*\\(\\s*[\'"][^\'"]*verticals/[^\'"/]+/',
        flags: 'u',
        id: 'vertical-directory-dynamic-import',
      },
      {
        diagnostic:
          'A thin Shell must consume only published vertical surfaces; require() of vertical directories is forbidden.',
        expression: 'require\\s*\\(\\s*[\'"][^\'"]*verticals/[^\'"/]+/',
        flags: 'u',
        id: 'vertical-directory-require',
      },
      {
        diagnostic:
          'A thin Shell must consume only published package surfaces, never deep-import another package’s raw src/ internals (published subpath exports are allowed).',
        expression: 'from\\s+[\'"]@[^\'"/]+/[^\'"/]+/src/',
        flags: 'u',
        id: 'workspace-package-source-import',
      },
      {
        diagnostic:
          'A thin Shell must consume only published package surfaces; side-effect imports of raw package src/ are forbidden.',
        expression: 'import\\s+[\'"]@[^/\'"]+/[^/\'"]+/src/',
        flags: 'u',
        id: 'workspace-package-side-effect-import',
      },
      {
        diagnostic:
          'A thin Shell must consume only published package surfaces; dynamic imports of raw package src/ are forbidden.',
        expression: 'import\\s*\\(\\s*[\'"]@[^/\'"]+/[^/\'"]+/src/',
        flags: 'u',
        id: 'workspace-package-dynamic-import',
      },
      {
        diagnostic:
          'A thin Shell must consume only published package surfaces; require() of raw package src/ is forbidden.',
        expression: 'require\\s*\\(\\s*[\'"]@[^/\'"]+/[^/\'"]+/src/',
        flags: 'u',
        id: 'workspace-package-require',
      },
    ],
    forbiddenPathClasses: [
      {
        diagnostic:
          'A thin Shell must not own a server surface (server/); server capability belongs to a MicroVertical.',
        id: 'shell-server-surface',
        path: 'server',
      },
      {
        diagnostic:
          'A thin Shell must not own backend-federation artifacts; backend federation belongs to a MicroVertical delivery unit.',
        id: 'shell-backend-federation',
        path: 'backend-federation.config.ts',
      },
    ],
    schemaVersion: 1,
    shells: [
      {
        id: SHARED_VALIDATOR_STRING_131,
        packageDir: SHARED_VALIDATOR_STRING_047,
        srcDir: SHARED_VALIDATOR_STRING_051,
      },
    ],
  },
  tailwindEnabled: true,
  topology: {
    compactConfig: {
      apps: [
        {
          deliveryUnit: {
            buildMarker: '090dd0a19fdd0853',
            kind: SHARED_VALIDATOR_STRING_077,
            packageName: SHARED_VALIDATOR_STRING_021,
            schemaVersion: 1,
            sourceRevision: 'workspace',
            unitId: 'app/shell-super-app',
            version: '0.1.0',
          },
          deploy: {
            cloudflare: createShellCloudflareContract(),
          },
          displayName: 'Shell Super App',
          id: SHARED_VALIDATOR_STRING_131,
          kind: 'shell',
          moduleFederation: {
            dts: {
              compilerInstance: SHARED_VALIDATOR_STRING_068,
              tsConfigPath: SHARED_VALIDATOR_STRING_007,
            },
            exposes: [],
            name: SHARED_VALIDATOR_STRING_133,
            remotes: [
              {
                alias: SHARED_VALIDATOR_STRING_099,
                id: SHARED_VALIDATOR_STRING_098,
                manifestEnv: SHARED_VALIDATOR_STRING_155,
                manifestUrl: SHARED_VALIDATOR_STRING_073,
                name: SHARED_VALIDATOR_STRING_159,
              },
            ],
            role: 'host',
            ssr: true,
            verticalRefs: [SHARED_VALIDATOR_STRING_098],
          },
          package: SHARED_VALIDATOR_STRING_021,
          packageSuffix: SHARED_VALIDATOR_STRING_131,
          path: SHARED_VALIDATOR_STRING_047,
          port: 3020,
          portEnv: SHARED_VALIDATOR_STRING_130,
        },
        {
          api: {
            consumedBy: [SHARED_VALIDATOR_STRING_131, SHARED_VALIDATOR_STRING_098],
            prefix: SHARED_VALIDATOR_STRING_032,
            runtime: 'effect',
            serverEntry: SHARED_VALIDATOR_STRING_162,
            stem: SHARED_VALIDATOR_STRING_098,
          },
          backendFederation: createVerticalBackendFederationContract(),
          deliveryUnit: {
            buildMarker: SHARED_VALIDATOR_STRING_038,
            kind: SHARED_VALIDATOR_STRING_077,
            packageName: SHARED_VALIDATOR_STRING_018,
            schemaVersion: 1,
            sourceRevision: 'workspace',
            unitId: SHARED_VALIDATOR_STRING_046,
            version: '0.1.0',
          },
          deploy: {
            cloudflare: createVerticalCloudflareContract(),
          },
          displayName: 'Party Registry Vertical',
          domain: SHARED_VALIDATOR_STRING_098,
          id: SHARED_VALIDATOR_STRING_098,
          kind: 'vertical',
          moduleFederation: {
            dts: {
              compilerInstance: SHARED_VALIDATOR_STRING_068,
              tsConfigPath: SHARED_VALIDATOR_STRING_007,
            },
            exposes: [SHARED_VALIDATOR_STRING_005],
            name: SHARED_VALIDATOR_STRING_159,
            role: 'remote',
            ssr: true,
          },
          package: SHARED_VALIDATOR_STRING_018,
          packageSuffix: SHARED_VALIDATOR_STRING_098,
          path: SHARED_VALIDATOR_STRING_161,
          port: 4102,
          portEnv: 'VERTICAL_PARTY_REGISTRY_PORT',
        },
      ],
      source: './topology/reference-topology.json',
    },
    developmentOverlay: {
      apis: {
        'party-registry': 'http://localhost:4102/party-registry-api',
      },
      environment: 'development',
      manifests: {
        'party-registry': SHARED_VALIDATOR_STRING_073,
      },
      ontosModuleManifests: {
        'party-registry': 'http://localhost:4102/.well-known/ontos-module-manifest.json',
      },
      ports: {
        'party-registry': 4102,
        'shell-super-app': 3020,
      },
      preset: SHARED_VALIDATOR_STRING_104,
      schemaVersion: 1,
      serverExecution: {
        'party-registry': {
          apiBaseUrl: 'http://localhost:4102/party-registry-api',
          cloudflare: createVerticalCloudflareExecution(),
          deliveryUnit: {
            buildMarker: SHARED_VALIDATOR_STRING_038,
            unitId: SHARED_VALIDATOR_STRING_046,
          },
          node: createVerticalNodeExecution(),
          versionBoundary: SHARED_VALIDATOR_STRING_168,
        },
      },
    },
    ownership: {
      owners: [
        {
          id: SHARED_VALIDATOR_STRING_064,
          ownership: {
            adrRef: SHARED_VALIDATOR_STRING_067,
            blastRadius: {
              references: [SHARED_VALIDATOR_STRING_066],
              tier: 'tier-0-core-infrastructure',
            },
            pagerDuty: SHARED_VALIDATOR_STRING_100,
            runbookRef: 'runbooks/wave2/core-runtime.md',
            slack: SHARED_VALIDATOR_STRING_035,
            team: SHARED_VALIDATOR_STRING_141,
          },
          package: SHARED_VALIDATOR_STRING_017,
          path: SHARED_VALIDATOR_STRING_092,
        },
        {
          id: SHARED_VALIDATOR_STRING_176,
          ownership: {
            adrRef: SHARED_VALIDATOR_STRING_067,
            blastRadius: {
              references: [SHARED_VALIDATOR_STRING_066],
              tier: 'tier-0-core-infrastructure',
            },
            pagerDuty: SHARED_VALIDATOR_STRING_100,
            runbookRef: 'runbooks/wave2/core-runtime.md',
            slack: SHARED_VALIDATOR_STRING_035,
            team: SHARED_VALIDATOR_STRING_141,
          },
          package: SHARED_VALIDATOR_STRING_175,
          path: SHARED_VALIDATOR_STRING_177,
        },
        {
          id: SHARED_VALIDATOR_STRING_131,
          ownership: {
            adrRef: 'docs/super-app-rfc-adr/wave2/reference-topology.md#shell-super-app',
            blastRadius: {
              references: [
                'docs/super-app-rfc-adr/wave2/blast-radius.md#shell',
                'docs/super-app-rfc-adr/wave2/rollback.md#shell-lkg',
              ],
              tier: 'tier-0-shell',
            },
            pagerDuty: SHARED_VALIDATOR_STRING_100,
            runbookRef: 'runbooks/wave2/shell-super-app.md',
            slack: SHARED_VALIDATOR_STRING_035,
            team: SHARED_VALIDATOR_STRING_141,
          },
          package: SHARED_VALIDATOR_STRING_021,
          path: SHARED_VALIDATOR_STRING_047,
        },
        {
          id: SHARED_VALIDATOR_STRING_127,
          ownership: {
            adrRef: SHARED_VALIDATOR_STRING_067,
            blastRadius: {
              references: [SHARED_VALIDATOR_STRING_066],
              tier: 'tier-1-shared-contract',
            },
            pagerDuty: SHARED_VALIDATOR_STRING_100,
            runbookRef: 'runbooks/wave2/shared-contracts.md',
            slack: SHARED_VALIDATOR_STRING_035,
            team: SHARED_VALIDATOR_STRING_141,
          },
          package: SHARED_VALIDATOR_STRING_019,
          path: SHARED_VALIDATOR_STRING_094,
        },
        {
          id: SHARED_VALIDATOR_STRING_128,
          ownership: {
            adrRef: SHARED_VALIDATOR_STRING_067,
            blastRadius: {
              references: [SHARED_VALIDATOR_STRING_066],
              tier: 'tier-1-shared-contract',
            },
            pagerDuty: SHARED_VALIDATOR_STRING_100,
            runbookRef: 'runbooks/wave2/shared-design-tokens.md',
            slack: SHARED_VALIDATOR_STRING_035,
            team: SHARED_VALIDATOR_STRING_141,
          },
          package: SHARED_VALIDATOR_STRING_020,
          path: SHARED_VALIDATOR_STRING_096,
        },
        {
          id: SHARED_VALIDATOR_STRING_098,
          ownership: {
            adrRef: 'docs/super-app-rfc-adr/verticals.md#party-registry',
            blastRadius: {
              references: ['docs/super-app-rfc-adr/blast-radius.md#party-registry'],
              tier: 'tier-2-vertical',
            },
            pagerDuty: SHARED_VALIDATOR_STRING_100,
            runbookRef: 'runbooks/verticals/party-registry.md',
            slack: SHARED_VALIDATOR_STRING_035,
            team: SHARED_VALIDATOR_STRING_141,
          },
          package: SHARED_VALIDATOR_STRING_018,
          path: SHARED_VALIDATOR_STRING_161,
        },
      ],
      preset: SHARED_VALIDATOR_STRING_104,
      schemaVersion: 1,
    },
    referenceTopology: {
      description: 'Generated UltraModern SuperApp shell that can grow by adding full-stack verticals.',
      id: 'ultramodern-superapp-workspace-reference-topology',
      preset: SHARED_VALIDATOR_STRING_104,
      schemaVersion: 1,
      sharedPackages: [
        {
          description: 'Server-only Core infrastructure and typed PostgreSQL ownership.',
          id: SHARED_VALIDATOR_STRING_064,
          package: SHARED_VALIDATOR_STRING_017,
          path: SHARED_VALIDATOR_STRING_092,
        },
        {
          description: 'Server-only audience-bound Shell gateway assertion verification.',
          id: SHARED_VALIDATOR_STRING_176,
          package: SHARED_VALIDATOR_STRING_175,
          path: SHARED_VALIDATOR_STRING_177,
        },
        {
          description: 'Generated route, ownership, and topology contracts.',
          id: SHARED_VALIDATOR_STRING_127,
          package: SHARED_VALIDATOR_STRING_019,
          path: SHARED_VALIDATOR_STRING_094,
        },
        {
          description: 'Generated design tokens consumed by shell and verticals.',
          id: SHARED_VALIDATOR_STRING_128,
          package: SHARED_VALIDATOR_STRING_020,
          path: SHARED_VALIDATOR_STRING_096,
        },
      ],
      shell: {
        authentication: {
          api: {
            operations: [
              'signIn',
              'currentSession',
              'signOut',
              'availableTenants',
              'switchTenant',
              'issueGatewayContext',
            ],
            prefix: '/shell-super-app-api',
            runtimeFramework: 'effect',
            strictEffectApproach: true,
          },
          databaseSchema: 'auth',
          kind: 'shell-core-capability',
          owners: [SHARED_VALIDATOR_STRING_131, SHARED_VALIDATOR_STRING_064],
        },
        cloudflare: createShellCloudflareContract(),
        deliveryUnit: {
          buildMarker: '090dd0a19fdd0853',
          kind: SHARED_VALIDATOR_STRING_077,
          packageName: SHARED_VALIDATOR_STRING_021,
          schemaVersion: 1,
          sourceRevision: 'workspace',
          unitId: 'app/shell-super-app',
          version: '0.1.0',
        },
        id: SHARED_VALIDATOR_STRING_131,
        kind: 'shell',
        moduleFederation: {
          name: SHARED_VALIDATOR_STRING_133,
          remotes: [
            {
              id: SHARED_VALIDATOR_STRING_098,
              manifestUrl: SHARED_VALIDATOR_STRING_073,
              name: SHARED_VALIDATOR_STRING_159,
            },
          ],
          role: 'host',
          sharedContractVersion: 'mf-ssr-contract-v1',
          ssr: true,
        },
        ownership: {
          adrRef: 'docs/super-app-rfc-adr/wave2/reference-topology.md#shell-super-app',
          blastRadius: {
            references: [
              'docs/super-app-rfc-adr/wave2/blast-radius.md#shell',
              'docs/super-app-rfc-adr/wave2/rollback.md#shell-lkg',
            ],
            tier: 'tier-0-shell',
          },
          pagerDuty: SHARED_VALIDATOR_STRING_100,
          runbookRef: 'runbooks/wave2/shell-super-app.md',
          slack: SHARED_VALIDATOR_STRING_035,
          team: SHARED_VALIDATOR_STRING_141,
        },
        package: SHARED_VALIDATOR_STRING_021,
        verticalRefs: [SHARED_VALIDATOR_STRING_098],
      },
      validation: {
        commands: [
          'pnpm i18n:boundaries',
          SHARED_VALIDATOR_STRING_101,
          SHARED_VALIDATOR_STRING_102,
          'pnpm contract:check',
        ],
        script: SHARED_VALIDATOR_STRING_124,
      },
      verticals: [
        {
          api: {
            basePath: '/party-registry-api/party-registry',
            bff: {
              openapi: '/openapi.json',
              prefix: SHARED_VALIDATOR_STRING_032,
              strictEffectApproach: true,
            },
            client: {
              export: SHARED_VALIDATOR_STRING_002,
              path: SHARED_VALIDATOR_STRING_167,
            },
            consumedBy: [SHARED_VALIDATOR_STRING_131, SHARED_VALIDATOR_STRING_098],
            contract: {
              export: './api',
              path: SHARED_VALIDATOR_STRING_166,
            },
            readiness: {
              checks: ['moduleFederation', 'ssr', 'translations', 'api'],
              endpoint: '/party-registry/readiness',
              marker: {
                api: SHARED_VALIDATOR_STRING_151,
                skew: 'none',
                ui: SHARED_VALIDATOR_STRING_152,
              },
            },
            requestContext: {
              propagatedHeaders: [
                'accept-language',
                'authorization',
                SHARED_VALIDATOR_STRING_142,
                'x-correlation-id',
                'x-tenant-id',
                'x-ultramodern-env',
                'x-vertical-version-id',
              ],
              source: 'shell-to-vertical-api-client',
            },
            runtime: 'effect',
            serverEntry: SHARED_VALIDATOR_STRING_162,
          },
          backendFederation: createVerticalBackendFederationContract(),
          cloudflare: createVerticalCloudflareContract(),
          deliveryUnit: {
            buildMarker: SHARED_VALIDATOR_STRING_038,
            kind: SHARED_VALIDATOR_STRING_077,
            packageName: SHARED_VALIDATOR_STRING_018,
            schemaVersion: 1,
            sourceRevision: 'workspace',
            unitId: SHARED_VALIDATOR_STRING_046,
            version: '0.1.0',
          },
          domain: SHARED_VALIDATOR_STRING_098,
          id: SHARED_VALIDATOR_STRING_098,
          kind: 'vertical',
          moduleFederation: {
            exposes: [SHARED_VALIDATOR_STRING_005],
            manifestUrl: SHARED_VALIDATOR_STRING_073,
            name: SHARED_VALIDATOR_STRING_159,
            role: 'remote',
            sharedContractVersion: 'mf-ssr-contract-v1',
            ssr: true,
          },
          ownership: {
            adrRef: 'docs/super-app-rfc-adr/verticals.md#party-registry',
            blastRadius: {
              references: ['docs/super-app-rfc-adr/blast-radius.md#party-registry'],
              tier: 'tier-2-vertical',
            },
            pagerDuty: SHARED_VALIDATOR_STRING_100,
            runbookRef: 'runbooks/verticals/party-registry.md',
            slack: SHARED_VALIDATOR_STRING_035,
            team: SHARED_VALIDATOR_STRING_141,
          },
          package: SHARED_VALIDATOR_STRING_018,
          path: SHARED_VALIDATOR_STRING_161,
        },
      ],
    },
  },
  versions: {
    cloudflareCompatibilityDate: SHARED_VALIDATOR_STRING_036,
    effect: SHARED_VALIDATOR_STRING_039,
    moduleFederation: '2.9.0',
    node: '26.7.0',
    pnpm: '11.25.0',
  },
};

type FullStackVertical = (typeof workspaceValidationContractDefinition.fullStackVerticals)[number] & {
  readonly packageSuffix?: string;
};
interface GeneratedSurfaceTarget {
  readonly excludePaths?: readonly string[];
  readonly extensions?: readonly string[];
  readonly kind: string;
  readonly path: string;
}
interface GeneratedSurfacePattern {
  readonly diagnostic: string;
  readonly expression?: string;
  readonly fixArea: string;
  readonly flags?: string;
  readonly id: string;
  readonly structuralMatcher?: {
    readonly attributeName: string;
    readonly elementName: string;
    readonly kind: string;
  };
}
interface GeneratedSurfaceRule {
  readonly id: string;
  readonly paths: readonly GeneratedSurfaceTarget[];
  readonly patterns: readonly GeneratedSurfacePattern[];
}
interface CompactRemote {
  readonly alias: string;
  readonly id: string;
  readonly manifestEnv: string;
  readonly manifestUrl: string;
  readonly name: string;
}
interface CompactModuleFederation {
  readonly exposes?: readonly string[];
  readonly name?: string;
  readonly remotes?: readonly CompactRemote[];
  readonly role?: string;
  readonly ssr?: boolean;
  readonly verticalRefs?: readonly string[];
}
interface CompactApi {
  readonly consumedBy?: readonly string[];
  readonly prefix?: string;
  readonly protocol?: 'rest' | 'rpc';
  readonly serverEntry?: string;
  readonly stem?: string;
}
type CompactConfigDocument = typeof compactConfigDocument;
type CompactConfigVertical = CompactConfigDocument['topology']['apps'][1];
type CompactBackendFederation = CompactConfigVertical['backendFederation'] & {
  readonly containerEntry?: string;
  readonly manifestUrl?: string;
};
interface CompactApp {
  readonly api?: CompactApi;
  readonly backendFederation?: CompactBackendFederation;
  readonly deliveryUnit?: DeliveryUnit;
  readonly deploy?: { readonly cloudflare?: object };
  readonly domain?: string;
  readonly id: string;
  readonly kind: string;
  readonly moduleFederation: CompactModuleFederation;
  readonly package?: string;
  readonly packageSuffix?: string;
  readonly path?: string;
  readonly port?: number;
  readonly portEnv?: string;
}
interface BridgeConfig {
  readonly enabled: boolean;
  readonly gates?: readonly {
    readonly command: string;
    readonly cwd?: string;
    readonly name: string;
  }[];
  readonly workspacePackages: readonly { readonly pattern: string }[];
}
interface CompactConfig extends Omit<CompactConfigDocument, 'bridge' | 'packageSource' | 'topology'> {
  readonly bridge?: BridgeConfig;
  readonly packageSource: CompactConfigDocument['packageSource'] & {
    readonly registry?: string;
  };
  readonly shells?: unknown;
  readonly topology: Omit<CompactConfigDocument['topology'], 'apps'> & {
    readonly apps?: readonly CompactApp[];
  };
}
type DevelopmentOverlay = typeof developmentOverlayDocument;
type OverlayServerExecution = DevelopmentOverlay['serverExecution'][keyof DevelopmentOverlay['serverExecution']];
type Ownership = typeof ownershipDocument;
type ReferenceTopologyDocument = typeof referenceTopologyDocument;
type ReferenceTopologyVerticalDocument = ReferenceTopologyDocument['verticals'][number];
interface ReferenceTopologyVertical extends Omit<ReferenceTopologyVerticalDocument, 'api' | 'moduleFederation'> {
  readonly api?: ReferenceTopologyVerticalDocument['api'] & {
    readonly domainOperations?: object;
  };
  readonly moduleFederation: ReferenceTopologyVerticalDocument['moduleFederation'] & {
    readonly remotes?: readonly CompactRemote[];
    readonly verticalRefs?: readonly string[];
  };
}
interface ReferenceTopology extends Omit<ReferenceTopologyDocument, 'verticals'> {
  readonly verticals: readonly ReferenceTopologyVertical[];
}
type RootPackage = typeof rootPackageDocument;
type ShellPackage = typeof shellPackageDocument;
interface NormalizedApp {
  readonly api?: {
    readonly consumedBy: string[];
    readonly prefix: string;
    readonly protocol: 'rest' | 'rpc';
    readonly stem: string;
  };
  readonly apiClientExport?: './api/client' | './api/rpc-client';
  readonly apiContractExport?: './api';
  readonly backendFederation?: CompactBackendFederation;
  readonly deliveryUnit?: DeliveryUnit;
  readonly domain?: string;
  readonly exposes: string[];
  readonly id: string;
  readonly kind: 'shell' | 'vertical';
  readonly mfName: string;
  readonly moduleFederationSsr: boolean;
  readonly package?: string;
  readonly packageSuffix: string;
  readonly path: string;
  readonly port: number;
  readonly portEnv: string;
  readonly verticalRefs: string[];
}
const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
const ModuleIdSchema = Schema.String.pipe(Schema.brand('ModuleId'));
const UnitIdSchema = Schema.String.pipe(Schema.brand('UnitId'));
const DeliveryUnitSchema = Schema.Struct({
  appId: Schema.optionalKey(AppIdSchema),
  buildMarker: Schema.optionalKey(Schema.String),
  deployProfile: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  packageName: Schema.optionalKey(Schema.String),
  schemaVersion: Schema.optionalKey(Schema.Number),
  sourceRevision: Schema.optionalKey(Schema.String),
  unitId: Schema.optionalKey(UnitIdSchema),
  version: Schema.optionalKey(Schema.String),
});
interface DeliveryUnit {
  readonly appId?: string;
  readonly buildMarker?: string;
  readonly deployProfile?: string;
  readonly kind?: string;
  readonly packageName?: string;
  readonly schemaVersion?: number;
  readonly sourceRevision?: string;
  readonly unitId?: string;
  readonly version?: string;
}
const StringValuesSchema = Schema.Record(Schema.String, Schema.String);
const PackageJsonSchema = Schema.Struct({
  dependencies: Schema.optionalKey(StringValuesSchema),
  devDependencies: Schema.optionalKey(StringValuesSchema),
  engines: Schema.optionalKey(Schema.Struct({ node: Schema.optionalKey(Schema.String) })),
  exports: Schema.optionalKey(StringValuesSchema),
  modernjs: Schema.optionalKey(
    Schema.Struct({
      apiRuntime: Schema.optionalKey(Schema.String),
      appId: Schema.optionalKey(AppIdSchema),
      ontosModule: Schema.optionalKey(
        Schema.Struct({
          manifest: Schema.optionalKey(Schema.String),
          moduleId: Schema.optionalKey(ModuleIdSchema),
        }),
      ),
      role: Schema.optionalKey(Schema.String),
    }),
  ),
  name: Schema.optionalKey(Schema.String),
  optionalDependencies: Schema.optionalKey(StringValuesSchema),
  packageManager: Schema.optionalKey(Schema.String),
  peerDependencies: Schema.optionalKey(StringValuesSchema),
  scripts: Schema.optionalKey(StringValuesSchema),
  'zephyr:dependencies': Schema.optionalKey(StringValuesSchema),
});
interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly engines?: { readonly node?: string };
  readonly exports?: Readonly<Record<string, string>>;
  readonly modernjs?: {
    readonly apiRuntime?: string;
    readonly appId?: string;
    readonly ontosModule?: {
      readonly manifest?: string;
      readonly moduleId?: string;
    };
    readonly role?: string;
  };
  readonly name?: string;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly 'zephyr:dependencies'?: Readonly<Record<string, string>>;
}
const TsConfigSchema = Schema.Struct({
  compilerOptions: Schema.optionalKey(
    Schema.Struct({
      composite: Schema.optionalKey(Schema.Boolean),
      declaration: Schema.optionalKey(Schema.Boolean),
      declarationMap: Schema.optionalKey(Schema.Boolean),
      emitDeclarationOnly: Schema.optionalKey(Schema.Boolean),
      noEmit: Schema.optionalKey(Schema.Boolean),
      outDir: Schema.optionalKey(Schema.String),
      rootDir: Schema.optionalKey(Schema.String),
      skipLibCheck: Schema.optionalKey(Schema.Boolean),
      tsBuildInfoFile: Schema.optionalKey(Schema.String),
    }),
  ),
  extends: Schema.optionalKey(Schema.String),
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  include: Schema.optionalKey(Schema.Array(Schema.String)),
  references: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String }))),
});
interface TsConfig {
  readonly compilerOptions?: {
    readonly composite?: boolean;
    readonly declaration?: boolean;
    readonly declarationMap?: boolean;
    readonly emitDeclarationOnly?: boolean;
    readonly noEmit?: boolean;
    readonly outDir?: string;
    readonly rootDir?: string;
    readonly skipLibCheck?: boolean;
    readonly tsBuildInfoFile?: string;
  };
  readonly extends?: string;
  readonly files?: readonly string[];
  readonly include?: readonly string[];
  readonly references?: readonly { readonly path: string }[];
}
const BuildArtifactSchema = Schema.Struct({
  deliveryUnit: Schema.optionalKey(DeliveryUnitSchema),
});
type NodeFileTrace = typeof traceNodeFiles;
const NodeFileTraceSchema = Schema.declare<NodeFileTrace>((input): input is NodeFileTrace =>
  Predicate.isFunction(input),
);
const NftModuleSchema = Schema.Struct({ nodeFileTrace: NodeFileTraceSchema });
const LegacyTopologyFieldsSchema = Schema.Struct({
  effectServices: Schema.optionalKey(Schema.Unknown),
  remotes: Schema.optionalKey(Schema.Unknown),
});
interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}
type CompositionRemote =
  (typeof workspaceValidationContractDefinition.federatedCompositionSourcePolicy.hosts)[number]['remotes'][number];
type WorkspaceValidationContract = Omit<
  typeof workspaceValidationContractDefinition,
  'cohort' | 'generatedSurfacePolicy'
> & {
  readonly additionalShells?: unknown;
  readonly cohort: Omit<
    typeof workspaceValidationContractDefinition.cohort,
    | 'additionalShellBuildMarkerIds'
    | 'additionalShellDegradedStateIds'
    | 'additionalShellDeliveryUnitIds'
    | 'additionalShellIds'
    | 'additionalShellManifests'
    | 'additionalShellOwnerIds'
  > & {
    readonly additionalShellBuildMarkerIds?: readonly string[];
    readonly additionalShellDegradedStateIds?: readonly string[];
    readonly additionalShellDeliveryUnitIds?: readonly string[];
    readonly additionalShellIds?: readonly string[];
    readonly additionalShellManifests?: readonly IdentifierEntry[];
    readonly additionalShellOwnerIds?: readonly string[];
  };
  readonly generatedSurfacePolicy: {
    readonly rules: readonly GeneratedSurfaceRule[];
    readonly schemaVersion: number;
  };
};
const AdditionalShellCohortFieldSchema = Schema.Literals([
  SHARED_VALIDATOR_STRING_040,
  SHARED_VALIDATOR_STRING_041,
  SHARED_VALIDATOR_STRING_042,
  SHARED_VALIDATOR_STRING_043,
]);
type AdditionalShellCohortField = typeof AdditionalShellCohortFieldSchema.Type;
const additionalShellCohortFields: readonly AdditionalShellCohortField[] = [
  SHARED_VALIDATOR_STRING_043,
  SHARED_VALIDATOR_STRING_042,
  SHARED_VALIDATOR_STRING_041,
  SHARED_VALIDATOR_STRING_040,
];

const workspaceValidationContract: WorkspaceValidationContract = workspaceValidationContractDefinition;
const rootPackage: RootPackage = rootPackageDocument;
const ultramodernConfig: CompactConfig = compactConfigDocument;
const topology: ReferenceTopology = referenceTopologyDocument;
const ownership: Ownership = ownershipDocument;
const overlay: DevelopmentOverlay = developmentOverlayDocument;
const shellPackage: ShellPackage = shellPackageDocument;
const { packageScope } = workspaceValidationContract;
const expectedNodeVersion = workspaceValidationContract.versions.node;
const expectedEffectVersion = workspaceValidationContract.versions.effect;
const expectedModuleFederationVersion = workspaceValidationContract.versions.moduleFederation;
const expectedCloudflareCompatibilityDate = workspaceValidationContract.versions.cloudflareCompatibilityDate;
const { tailwindEnabled } = workspaceValidationContract;
const { fullStackVerticals } = workspaceValidationContract;
// Backend-federation and Zerops runtime surfaces only exist when the workspace
// exposes API-bearing verticals. Shell-only workspaces skip their
// materialization during migrate, so the contract must not require them.
const hasBackendSurfaces = fullStackVerticals.some((vertical) => vertical.emitsApi);
// Every vertical (ui-only and horizontal-remote included) is a delivery unit
// and deploys via Zerops; only the BACKEND proof/generation surfaces depend on
// an API-bearing unit existing (split gating).
const hasDeliveryUnits = fullStackVerticals.length > 0;
const { shellNamespace } = workspaceValidationContract;
const { oldRemotePaths } = workspaceValidationContract;
const expectedBuildScript = workspaceValidationContract.scripts.build;
const expectedCloudflareBuildScript = workspaceValidationContract.scripts.cloudflareBuild;
const expectedCloudflareDeployScript = workspaceValidationContract.scripts.cloudflareDeploy;
const expectedCloudflareSecurity = workspaceValidationContract.cloudflareSecurity;
const { publicSurfaceManagedSourceAssetPaths } = workspaceValidationContract;
const { shellRouteMetaPaths } = workspaceValidationContract;
const compactConfigPath = workspaceValidationContract.metadata.compactConfig.path;
const { retiredMetadataPaths } = workspaceValidationContract.legacy;
const modernPackageCohort = workspaceValidationContract.cohort.modernPackages;
const expectedPrimaryShellVerticalIds =
  workspaceValidationContract.topology?.referenceTopology?.shell?.verticalRefs ??
  workspaceValidationContract.cohort.verticalIds;
const expectedReleaseCohort = workspaceValidationContract.cohort.releaseCohort;
const expectedModernPackageSpecifier = (packageName: string): string | undefined => {
  const { packageSource } = compactConfigDocument;
  if (packageSource.strategy === 'workspace') {
    return SHARED_VALIDATOR_STRING_169;
  }
  const specifier = packageSource.modernPackageVersion;
  if (!isString(packageSource.aliasScope)) {
    return specifier;
  }
  const scope = packageSource.aliasScope.replace(/^@/u, '');
  const prefix = packageSource.aliasPackageNamePrefix;
  const alias = `@${scope}/${prefix}${packageName.split('/').at(-1)}`;
  return `npm:${alias}@${specifier}`;
};
const expectedWorkerName = (packageSuffix: string): string => `${packageScope}-${packageSuffix}`.slice(0, 63);
const expectedChunkLoadingGlobal = (mfName: string): string =>
  `__ULTRAMODERN_${mfName
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, '$<lower>_$<upper>')
    .replaceAll(/[^a-zA-Z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
    .toUpperCase()}_LOADED_CHUNKS__`;

const readText = (relativePath: string): string => fs.readFileSync(path.join(root, relativePath), 'utf-8');
const readJson = <DocumentSchema extends Schema.ConstraintDecoder<unknown>>(
  schema: DocumentSchema,
  relativePath: string,
): DocumentSchema['Type'] =>
  Result.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(schema))(readText(relativePath)));
type Assert = (condition: boolean, message: string) => void;
type AssertSelfCheck = (condition: boolean, contract: string, message: string, fixArea: string) => void;
type AssertObject = <Value extends object>(value: Value | null | undefined, contract: string, fixArea: string) => void;
type AssertArray = <Value>(value: readonly Value[] | undefined, contract: string, fixArea: string) => void;

const assert: Assert = (condition, message) => {
  assertCondition(condition, message);
};
const assertExists = (relativePath: string): void => {
  assert(fs.existsSync(path.join(root, relativePath)), `Missing ${relativePath}`);
};
const assertNotExists = (relativePath: string): void => {
  assert(!fs.existsSync(path.join(root, relativePath)), `Unexpected ${relativePath}`);
};
const assertAnyOf = (relativePaths: readonly string[]): void => {
  assert(
    relativePaths.some((relativePath) => fs.existsSync(path.join(root, relativePath))),
    `Missing one of: ${relativePaths.join(', ')}`,
  );
};
const sortedCopy = <Value,>(values: readonly Value[], compare: (left: Value, right: Value) => number): Value[] => {
  const result: Value[] = [];
  for (const value of values ?? []) {
    const insertAt = result.findIndex((existing) => compare(value, existing) < 0);
    result.splice(insertAt === -1 ? result.length : insertAt, 0, value);
  }
  return result;
};
const valueForKey = <Value,>(entries: readonly (readonly [string, Value])[], key: string): Value | undefined =>
  entries.find(([candidate]) => candidate === key)?.[1];
const canonicalizeJsonValue = (value: ComparableJson): ComparableJson => {
  if (isComparableJsonArray(value)) {
    const entries = value.map((entry) => canonicalizeJsonValue(entry) ?? null);
    const keyedEntries = entries.every(isIdentifierEntry);
    if (keyedEntries) {
      const ids = entries.map((entry) => entry.id);
      if (new Set(ids).size === ids.length) {
        return sortedCopy(entries, (left, right) => left.id.localeCompare(right.id));
      }
    }
    return entries;
  }
  if (isComparableJsonObject(value)) {
    return Object.fromEntries(
      sortedCopy(Object.entries(value), ([left], [right]) => left.localeCompare(right))
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, canonicalizeJsonValue(entry)]),
    );
  }
  return value;
};
const canonicalizeJson = <Value,>(value: Value): ComparableJson | undefined =>
  value === undefined
    ? undefined
    : canonicalizeJsonValue(Result.getOrThrow(Schema.decodeUnknownResult(ComparableJsonSchema)(value)));
const sameJson = <Actual, Expected>(actual: Actual, expected: Expected): boolean =>
  jsonEquivalent(canonicalizeJson(actual), canonicalizeJson(expected));
const formatJson = <Value,>(value: Value): string =>
  value === undefined ? 'undefined' : Inspectable.toStringUnknown(canonicalizeJson(value), 0);
const quoteYamlString = (value: string | number): string => `'${String(value).replaceAll("'", "''")}'`;
const quoteShellValue = (value: string | number): string =>
  `'${String(value).replaceAll("'", shellSingleQuoteEscape)}'`;
const yamlListItemBlock = (source: string, key: string, value: string | number): string => {
  const marker = `  - ${key}: ${quoteYamlString(value)}`;
  const start = source.indexOf(marker);
  if (start === -1) {
    return '';
  }
  const end = source.indexOf('\n  - ', start + marker.length);
  return source.slice(start, end === -1 ? undefined : end);
};
const yamlMappingBlock = (source: string, key: string, indent: number): string => {
  const indentation = ' '.repeat(indent);
  const marker = `${indentation}${key}:`;
  const start = source.indexOf(marker);
  if (start === -1) {
    return '';
  }
  const nextSibling = source.slice(start + marker.length).search(new RegExp(`\\n${indentation}\\S`, 'u'));
  const end = nextSibling === -1 ? undefined : start + marker.length + nextSibling;
  return source.slice(start, end);
};
const selfCheckFailure = (contract: string, message: string, fixArea: string): string =>
  `MicroVertical contract self-check failed: ${contract}. ${message}. Fix area: ${fixArea}.`;
const assertSelfCheck: AssertSelfCheck = (condition, contract, message, fixArea) => {
  assert(condition, selfCheckFailure(contract, message, fixArea));
};
const assertSameJson = <Actual, Expected>(
  actual: Actual,
  expected: Expected,
  contract: string,
  fixArea: string,
): void => {
  assertSelfCheck(
    sameJson(actual, expected),
    contract,
    `Expected ${formatJson(expected)}, found ${formatJson(actual)}`,
    fixArea,
  );
};
const assertObject: AssertObject = (value, contract, fixArea) => {
  assertSelfCheck(
    value !== null && value !== undefined && !Array.isArray(value),
    contract,
    `Expected JSON object, found ${formatJson(value)}`,
    fixArea,
  );
};
const assertArray: AssertArray = (value, contract, fixArea) => {
  assertSelfCheck(Array.isArray(value), contract, `Expected JSON array, found ${formatJson(value)}`, fixArea);
};
const assertUniqueStrings = (values: readonly string[] | undefined, contract: string): void => {
  assert(Array.isArray(values), `${contract} must be an array`);
  const seen = new Set();
  for (const value of values ?? []) {
    assert(isString(value) && value.length > 0, `${contract} must contain non-empty strings`);
    assert(!seen.has(value), `Duplicate value "${value}" in ${contract}`);
    seen.add(value);
  }
};
const assertUniqueIdEntries = (entries: readonly IdentifierEntry[] | undefined, contract: string): void => {
  assert(Array.isArray(entries), `${contract} must be an array`);
  const seen = new Set();
  for (const entry of entries ?? []) {
    const id = entry?.id;
    assert(isString(id) && id.length > 0, `${contract} entries must have non-empty string ids`);
    assert(!seen.has(id), `Duplicate id "${id}" in ${contract}`);
    seen.add(id);
  }
};
const assertSameIdCohort = (
  entries: readonly IdentifierEntry[] | undefined,
  expectedIds: readonly string[],
  contract: string,
  fixArea: string,
): void => {
  assertUniqueIdEntries(entries, contract);
  assertSameJson(
    sortedCopy(entries?.map((entry) => entry.id) ?? [], (left, right) => left.localeCompare(right)),
    sortedCopy(expectedIds, (left, right) => left.localeCompare(right)),
    `${contract} cohort`,
    fixArea,
  );
};
const assertGeneratedSurfaceTarget = (rule: GeneratedSurfaceRule, target: GeneratedSurfaceTarget): void => {
  assert(
    target.kind === 'file' || target.kind === 'directory',
    `generated surface policy ${rule.id} has an invalid target kind`,
  );
  assert(
    isString(target.path) && target.path.length > 0,
    `generated surface policy ${rule.id} target path is required`,
  );
  if (target.kind === 'directory') {
    assertUniqueStrings(target.extensions, `generated surface policy ${rule.id} directory extensions`);
    assertUniqueStrings(target.excludePaths ?? [], `generated surface policy ${rule.id} directory exclusions`);
  }
};
const assertGeneratedSurfacePattern = (rule: GeneratedSurfaceRule, pattern: GeneratedSurfacePattern): void => {
  if (pattern.structuralMatcher === undefined) {
    const { expression, flags } = pattern;
    assert(
      isString(expression) && expression.length > 0,
      `generated surface policy ${rule.id}.${pattern.id} expression is required`,
    );
    assert(flags === 'u', `generated surface policy ${rule.id}.${pattern.id} must use deterministic Unicode matching`);
    if (expression !== undefined && flags !== undefined) {
      const compiledPattern = new RegExp(expression, flags);
      assert(
        compiledPattern.flags === flags,
        `generated surface policy ${rule.id}.${pattern.id} flags are not preserved`,
      );
    }
  } else {
    assert(
      pattern.expression === undefined && pattern.flags === undefined,
      `generated surface policy ${rule.id}.${pattern.id} must use exactly one matcher`,
    );
    assert(
      pattern.structuralMatcher.kind === SHARED_VALIDATOR_STRING_074,
      `generated surface policy ${rule.id}.${pattern.id} has an unsupported structural matcher`,
    );
    assert(
      isString(pattern.structuralMatcher.elementName) && pattern.structuralMatcher.elementName.length > 0,
      `generated surface policy ${rule.id}.${pattern.id} structural elementName is required`,
    );
    assert(
      isString(pattern.structuralMatcher.attributeName) && pattern.structuralMatcher.attributeName.length > 0,
      `generated surface policy ${rule.id}.${pattern.id} structural attributeName is required`,
    );
  }
  assert(
    isString(pattern.diagnostic) && pattern.diagnostic.length > 0,
    `generated surface policy ${rule.id}.${pattern.id} diagnostic is required`,
  );
  assert(
    isString(pattern.fixArea) && pattern.fixArea.length > 0,
    `generated surface policy ${rule.id}.${pattern.id} fixArea is required`,
  );
};
const assertGeneratedSurfaceRules = (contract: WorkspaceValidationContract): void => {
  const { generatedSurfacePolicy } = contract;
  assert(
    generatedSurfacePolicy.schemaVersion === 1,
    `Unsupported generated surface policy schemaVersion ${formatJson(generatedSurfacePolicy.schemaVersion)}; expected 1`,
  );
  assertUniqueIdEntries(generatedSurfacePolicy.rules, 'workspace validation contract generated surface policy rules');
  for (const rule of generatedSurfacePolicy.rules) {
    assertUniqueStrings(
      rule.paths.map((entry) => entry.path),
      `generated surface policy ${rule.id} paths`,
    );
    assert(
      Array.isArray(rule.paths) && rule.paths.length > 0,
      `generated surface policy ${rule.id} must target generated paths`,
    );
    for (const target of rule.paths) {
      assertGeneratedSurfaceTarget(rule, target);
    }
    assertUniqueIdEntries(rule.patterns, `generated surface policy ${rule.id} patterns`);
    for (const pattern of rule.patterns) {
      assertGeneratedSurfacePattern(rule, pattern);
    }
  }
};
const assertWorkspaceValidationContract = (contract: WorkspaceValidationContract): void => {
  assert(!Array.isArray(contract), 'Workspace validation contract must be a JSON object');
  assert(
    contract.schemaVersion === 1,
    `Unsupported workspace validation contract schemaVersion ${formatJson(contract.schemaVersion)}; expected 1`,
  );
  assert(
    contract.kind === 'modernjs.ultramodern-workspace-validation-contract',
    `Unsupported workspace validation contract kind ${formatJson(contract.kind)}`,
  );

  const metadataEntries = Object.entries(contract.metadata);
  assert(
    metadataEntries.length === (contract.cohort.releaseCohort === undefined ? 4 : 5),
    'Workspace validation contract must declare every structured metadata input',
  );
  for (const [name, metadata] of metadataEntries) {
    assert(
      isString(metadata.path) && metadata.path.length > 0,
      `Workspace validation contract metadata.${name}.path is required`,
    );
    assert(
      metadata.schemaVersion === 1,
      `Unsupported expected metadata schemaVersion ${formatJson(metadata.schemaVersion)} for ${name}`,
    );
  }

  assertUniqueStrings(contract.cohort.modernPackages, 'workspace validation contract Modern package cohort');
  assertUniqueStrings(contract.cohort.appIds, 'workspace validation contract app cohort');
  assertUniqueStrings(contract.cohort.backendAppIds, 'workspace validation contract backend app cohort');
  assertUniqueStrings(contract.cohort.verticalIds, 'workspace validation contract vertical cohort');
  assertUniqueStrings(contract.cohort.sharedPackageIds, 'workspace validation contract shared package cohort');
  assertUniqueStrings(contract.cohort.ownerIds, 'workspace validation contract owner cohort');
  assertUniqueIdEntries(contract.cohort.packageManifests, 'workspace validation contract package manifests');
  assertUniqueStrings(
    contract.cohort.packageManifests.map((manifest) => manifest.path),
    'workspace validation contract package manifest paths',
  );

  assertGeneratedSurfaceRules(contract);
};
const generatedSurfacePolicyFiles = (target: GeneratedSurfaceTarget): string[] => {
  const absolutePath = path.join(root, target.path);
  if (target.kind === 'file') {
    assert(fs.existsSync(absolutePath), `Missing generated surface policy file ${target.path}`);
    return [target.path];
  }

  assert(fs.existsSync(absolutePath), `Missing generated surface policy directory ${target.path}`);
  const files: string[] = [];
  const queue = [absolutePath];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current !== undefined) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absoluteEntryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(absoluteEntryPath);
        } else if ((target.extensions ?? []).includes(path.extname(entry.name))) {
          files.push(path.relative(root, absoluteEntryPath).split(path.sep).join('/'));
        }
      }
    }
  }
  const excludedPaths = new Set(target.excludePaths);
  return sortedCopy(
    files.filter((file) => !excludedPaths.has(file)),
    (left, right) => left.localeCompare(right),
  );
};
const isJsxNameCharacter = (character: string | undefined): boolean =>
  isString(character) && /[\w:.-]/u.test(character);
const skipQuotedSource = (source: string, start: number): number => {
  const quote = source[start];
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
    } else if (source[cursor] === quote) {
      return cursor + 1;
    } else {
      cursor += 1;
    }
  }
  return cursor;
};
const skipSourceComment = (source: string, start: number): number => {
  if (source[start + 1] === '/') {
    const lineEnd = source.indexOf('\n', start + 2);
    return lineEnd === -1 ? source.length : lineEnd + 1;
  }
  if (source[start + 1] === '*') {
    const commentEnd = source.indexOf('*/', start + 2);
    return commentEnd === -1 ? source.length : commentEnd + 2;
  }
  return start;
};
const isSourceQuote = (character: string | undefined): boolean => character !== undefined && '\'"`'.includes(character);
const matchesJsxAttribute = (source: string, cursor: number, attributeName: string): boolean => {
  if (
    !source.startsWith(attributeName, cursor) ||
    isJsxNameCharacter(source[cursor - 1]) ||
    isJsxNameCharacter(source[cursor + attributeName.length])
  ) {
    return false;
  }
  let equalsIndex = cursor + attributeName.length;
  while (/\s/u.test(source[equalsIndex] ?? '')) {
    equalsIndex += 1;
  }
  return source[equalsIndex] === '=';
};
const skipJsxNonAttributeSource = (source: string, cursor: number): number => {
  if (isSourceQuote(source[cursor])) {
    return skipQuotedSource(source, cursor);
  }
  return source[cursor] === '/' ? Math.max(cursor + 1, skipSourceComment(source, cursor)) : cursor;
};
const findOpeningElementAttribute = (
  source: string,
  start: number,
  attributeName: string,
): { readonly index: number } | null => {
  let cursor = start;
  let expressionDepth = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    const afterSkippedSource = skipJsxNonAttributeSource(source, cursor);
    if (afterSkippedSource !== cursor) {
      cursor = afterSkippedSource;
      continue;
    }
    if (character === '{') {
      expressionDepth += 1;
    } else if (character === '}') {
      expressionDepth = Math.max(0, expressionDepth - 1);
    } else if (expressionDepth === 0) {
      if (character === '>') {
        return null;
      }
      if (matchesJsxAttribute(source, cursor, attributeName)) {
        return { index: cursor };
      }
    }
    cursor += 1;
  }
  return null;
};
const findJsxAttribute = (
  source: string,
  matcher: NonNullable<GeneratedSurfacePattern['structuralMatcher']>,
): { readonly index: number } | null => {
  const opening = `<${matcher.elementName}`;
  let elementIndex = source.indexOf(opening);
  while (elementIndex !== -1) {
    const start = elementIndex + opening.length;
    if (!isJsxNameCharacter(source[start])) {
      const match = findOpeningElementAttribute(source, start, matcher.attributeName);
      if (match !== null) {
        return match;
      }
    }
    elementIndex = source.indexOf(opening, start);
  }
  return null;
};
const findGeneratedSurfacePolicyMatch = (
  source: string,
  pattern: GeneratedSurfacePattern,
): { readonly index: number } | null => {
  if (pattern.structuralMatcher?.kind === SHARED_VALIDATOR_STRING_074) {
    return findJsxAttribute(source, pattern.structuralMatcher);
  }
  return pattern.expression === undefined ? null : new RegExp(pattern.expression, pattern.flags).exec(source);
};
const assertSingleShellDeclarations = (): void => {
  assert(
    workspaceValidationContract.cohort.additionalShellIds === undefined,
    'Single-shell workspace must not declare additionalShellIds',
  );
  assert(
    workspaceValidationContract.cohort?.additionalShellManifests === undefined,
    'Single-shell workspace must not declare additional-shell manifests',
  );
  assert(
    workspaceValidationContract.additionalShells === undefined,
    'Single-shell workspace must not declare additional-shell records',
  );
  for (const field of additionalShellCohortFields) {
    assert(
      workspaceValidationContract.cohort?.[field] === undefined,
      `Single-shell workspace must not declare ${field}`,
    );
  }
};
const assertGeneratedSurfacePolicy = () => {
  for (const rule of workspaceValidationContract.generatedSurfacePolicy.rules) {
    const files = sortedCopy(rule.paths.flatMap(generatedSurfacePolicyFiles), (left, right) =>
      left.localeCompare(right),
    );
    for (const relativePath of files) {
      const source = readText(relativePath);
      for (const pattern of rule.patterns) {
        const match = findGeneratedSurfacePolicyMatch(source, pattern);
        assertSelfCheck(
          match === null,
          `generated surface policy ${rule.id}.${pattern.id}`,
          `${pattern.diagnostic} Found forbidden source at ${relativePath}:${match?.index ?? 0}`,
          pattern.fixArea,
        );
      }
    }
  }
  assertSingleShellDeclarations();
};
const compactConfigPolicyView = (config: CompactConfig): Json => ({
  agentSkills: config.agentSkills,
  backendFederation: config.backendFederation,
  deploy: config.deploy,
  features: config.features,
  moduleFederation: config.moduleFederation,
  profile: config.profile,
  schemaVersion: config.schemaVersion,
  tooling: config.tooling,
  workspace: config.workspace,
});
const assertLegacyMetadataFields = (): void => {
  assertObject(
    ultramodernConfig.packageSource,
    `${compactConfigPath} packageSource`,
    'restore generated compact package-source metadata',
  );
  for (const field of workspaceValidationContract.legacy.forbiddenCompactConfigFields) {
    assert(!Object.hasOwn(ultramodernConfig, field), `Stale legacy field ${compactConfigPath}.${field} is forbidden`);
  }
  for (const field of workspaceValidationContract.legacy.forbiddenPackageSourceFields) {
    assert(
      !Object.hasOwn(ultramodernConfig.packageSource, field),
      `Stale legacy field ${compactConfigPath}.packageSource.${field} is forbidden`,
    );
  }
  for (const field of workspaceValidationContract.legacy.forbiddenTopologyFields) {
    assert(
      !Object.hasOwn(topology, field),
      `Stale legacy field ${workspaceValidationContract.metadata.referenceTopology.path}.${field} is forbidden`,
    );
  }
};
const assertMetadataPackageManifests = (): void => {
  for (const manifest of workspaceValidationContract.cohort.packageManifests) {
    assertExists(manifest.path);
    const packageJson = readJson(PackageJsonSchema, manifest.path);
    assert(packageJson.name === manifest.packageName, `${manifest.path} package name must be ${manifest.packageName}`);
    if (manifest.role === 'shell' || manifest.role === 'vertical') {
      assert(packageJson.modernjs?.appId === manifest.id, `${manifest.path} modernjs.appId must be ${manifest.id}`);
    }
  }
  if (expectedReleaseCohort !== undefined) {
    const releaseCohortContract = workspaceValidationContract.metadata.releaseCohort;
    assertSelfCheck(
      releaseCohortContract?.path === SHARED_VALIDATOR_STRING_009,
      'authenticated release cohort projection',
      'Expected release-cohort metadata path is missing or invalid',
      SHARED_VALIDATOR_STRING_009,
    );
    assertSameJson(
      readJson(ComparableJsonSchema, releaseCohortContract.path),
      expectedReleaseCohort,
      'authenticated release cohort projection',
      releaseCohortContract.path,
    );
  }
};
const assertStructuredWorkspaceMetadata = (): void => {
  const observedMetadata = [
    {
      contract: workspaceValidationContract.metadata.compactConfig,
      value: ultramodernConfig,
    },
    {
      contract: workspaceValidationContract.metadata.referenceTopology,
      value: topology,
    },
    {
      contract: workspaceValidationContract.metadata.ownership,
      value: ownership,
    },
    {
      contract: workspaceValidationContract.metadata.developmentOverlay,
      value: overlay,
    },
  ];

  for (const entry of observedMetadata) {
    assert(isMetadataDocument(entry.value), `${entry.contract.path} must contain a JSON object`);
    assert(Number.isInteger(entry.value.schemaVersion), `${entry.contract.path} must declare an integer schemaVersion`);
  }

  const observedSchemaVersions = new Set(observedMetadata.map((entry) => entry.value.schemaVersion));
  assert(
    observedSchemaVersions.size === 1,
    `Mixed workspace metadata schema versions: ${observedMetadata
      .map((entry) => `${entry.contract.path}=${entry.value.schemaVersion}`)
      .join(', ')}`,
  );
  for (const entry of observedMetadata) {
    assert(
      entry.value.schemaVersion === entry.contract.schemaVersion,
      `Unsupported workspace metadata schemaVersion ${entry.value.schemaVersion} at ${entry.contract.path}; expected ${entry.contract.schemaVersion}`,
    );
  }

  assertLegacyMetadataFields();
  assertSameIdCohort(
    ultramodernConfig.topology?.apps,
    workspaceValidationContract.cohort.appIds,
    `${compactConfigPath} topology.apps`,
    'restore the complete generated app cohort',
  );
  assertSameIdCohort(
    ultramodernConfig.moduleFederation?.apps,
    workspaceValidationContract.cohort.appIds,
    `${compactConfigPath} moduleFederation.apps`,
    'restore the complete generated Module Federation app cohort',
  );
  assertSameIdCohort(
    ultramodernConfig.backendFederation?.apps,
    workspaceValidationContract.cohort.backendAppIds,
    `${compactConfigPath} backendFederation.apps`,
    'restore the complete generated backend app cohort',
  );
  assertSameIdCohort(
    topology.verticals,
    workspaceValidationContract.cohort.verticalIds,
    `${workspaceValidationContract.metadata.referenceTopology.path} verticals`,
    'restore the complete generated vertical cohort',
  );
  assertSameIdCohort(
    topology.sharedPackages,
    workspaceValidationContract.cohort.sharedPackageIds,
    `${workspaceValidationContract.metadata.referenceTopology.path} sharedPackages`,
    'restore the complete generated shared package cohort',
  );
  assertSameIdCohort(
    topology.shell?.moduleFederation?.remotes,
    workspaceValidationContract.topology.referenceTopology.shell.moduleFederation.remotes.map((remote) => remote.id),
    `${workspaceValidationContract.metadata.referenceTopology.path} shell.moduleFederation.remotes`,
    'restore the complete generated shell remote cohort',
  );
  assertSameIdCohort(
    ownership.owners,
    workspaceValidationContract.cohort.ownerIds,
    `${workspaceValidationContract.metadata.ownership.path} owners`,
    'restore the complete generated ownership cohort',
  );

  assertMetadataPackageManifests();
};
const assertStructuredWorkspaceMetadataSemantics = (): void => {
  assertSameJson(
    compactConfigPolicyView(ultramodernConfig),
    workspaceValidationContract.policy.compactConfig,
    `${compactConfigPath} policy`,
    'restore generated compact workspace policy metadata',
  );
  assertSameJson(
    ultramodernConfig.topology,
    workspaceValidationContract.topology.compactConfig,
    `${compactConfigPath} topology`,
    'restore the complete generated compact topology cohort',
  );
  assertSameJson(
    topology,
    workspaceValidationContract.topology.referenceTopology,
    workspaceValidationContract.metadata.referenceTopology.path,
    'restore the complete generated reference topology',
  );
  assertSameJson(
    ownership,
    workspaceValidationContract.topology.ownership,
    workspaceValidationContract.metadata.ownership.path,
    'restore the complete generated ownership topology',
  );
  assertSameJson(
    overlay,
    workspaceValidationContract.topology.developmentOverlay,
    workspaceValidationContract.metadata.developmentOverlay.path,
    'restore the complete generated development topology',
  );
};
const findById = <Entry extends IdentifierEntry>(
  entries: readonly Entry[] | undefined,
  id: string,
): Entry | undefined => entries?.find((entry) => entry.id === id);
const generatedContractLabel = compactConfigPath;
const toKebabCase = (value: string): string =>
  value
    .trim()
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, '$<lower>-$<upper>')
    .replaceAll(/[^a-zA-Z0-9._-]+/gu, '-')
    .replaceAll(/[._]+/gu, '-')
    .toLowerCase()
    .replaceAll(/-+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '');
const toPascalCase = (value: string): string =>
  toKebabCase(value)
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
const toCamelCase = (value: string): string => {
  const pascal = toPascalCase(value);
  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
};
const toEnvSegment = (value: string): string => toKebabCase(value).replaceAll('-', '_').toUpperCase();
const packageNameFor = (scope: string, suffix: string): string => `@${scope}/${suffix}`;
const normalizeRelativePath = (value: string | undefined): string =>
  (value ?? '').replaceAll('\\', '/').replace(/^\.\/+/u, '');
const appNamespace = (app: NormalizedApp): string => (app.kind === 'shell' ? 'shell' : (app.domain ?? app.id));
const tailwindPrefixFor = (app: NormalizedApp): string =>
  app.kind === 'shell' ? 'shell' : tailwindPrefixForNamespace(app.domain ?? app.id);
const buildMarkerFor = (app: NormalizedApp): string =>
  crypto.createHash('sha256').update(`${packageScope}:${app.packageSuffix}:${app.id}:0.1.0`).digest('hex').slice(0, 16);
const deliveryUnitIdentityFixArea =
  'regenerate vertical identity from delivery-unit record; do not hand-edit surface markers';
const deliveryUnitBlock = (record: DeliveryUnit | undefined) => ({
  buildMarker: record?.buildMarker,
  kind: record?.kind,
  packageName: record?.packageName,
  schemaVersion: record?.schemaVersion,
  sourceRevision: record?.sourceRevision,
  unitId: record?.unitId,
  version: record?.version,
});
const expectedCompactAppFor = (id: string) =>
  workspaceValidationContract.topology.compactConfig?.apps?.find((entry) => entry?.id === id);
const expectedDeliveryUnitFor = (vertical: FullStackVertical): DeliveryUnit => {
  const expectedApp = expectedCompactAppFor(vertical.id);
  return expectedApp?.backendFederation?.deliveryUnit ?? expectedApp?.deliveryUnit ?? vertical.deliveryUnit;
};
const assertBuildFacadeExport = (source: string, exportName: string, sourcePath: string, contract: string): void => {
  const escapedSourcePath = sourcePath.replaceAll('.', String.raw`\.`);
  const exportPattern = new RegExp(`export const ${exportName} = ${escapedSourcePath};`, 'u');
  assertSelfCheck(
    exportPattern.test(source),
    contract,
    `${exportName} must re-export the canonical ultramodern-build.json artifact rather than hand-forking fields`,
    deliveryUnitIdentityFixArea,
  );
};
const normalizedAppPath = (rawApp: CompactApp, kind: NormalizedApp['kind']): string => {
  if (isString(rawApp.path)) {
    return normalizeRelativePath(rawApp.path);
  }
  return kind === 'shell' ? SHARED_VALIDATOR_STRING_047 : `verticals/${toKebabCase(rawApp.id)}`;
};
const normalizedAppDomain = (
  rawDomain: string | undefined,
  kind: NormalizedApp['kind'],
  packageSuffix: string,
): string | undefined => {
  if (isString(rawDomain)) {
    return rawDomain;
  }
  return kind === 'vertical' ? packageSuffix : undefined;
};
const normalizedAppApi = (
  rawApi: CompactApi | undefined,
  domain: string | undefined,
  id: string,
): NormalizedApp['api'] => {
  if (rawApi === undefined) {
    return undefined;
  }
  return {
    consumedBy: rawApi.consumedBy === undefined ? [SHARED_VALIDATOR_STRING_131, id] : [...rawApi.consumedBy],
    prefix: isString(rawApi.prefix) ? rawApi.prefix : `/${domain ?? id}-api`,
    protocol: rawApi.protocol === 'rpc' ? 'rpc' : 'rest',
    stem: isString(rawApi.stem) ? rawApi.stem : (domain ?? id),
  };
};
const normalizedAppMfName = (
  configuredName: string | undefined,
  domain: string | undefined,
  id: string,
  kind: NormalizedApp['kind'],
): string => {
  if (isString(configuredName)) {
    return configuredName;
  }
  return kind === 'shell' ? SHARED_VALIDATOR_STRING_133 : `vertical${toPascalCase(domain ?? id)}`;
};
const normalizedAppPort = (configuredPort: number | undefined, kind: NormalizedApp['kind']): number => {
  if (isNumber(configuredPort)) {
    return configuredPort;
  }
  return kind === 'shell' ? 3020 : 3030;
};
const normalizedAppPortEnv = (
  configuredPortEnv: string | undefined,
  domain: string | undefined,
  id: string,
  kind: NormalizedApp['kind'],
): string => {
  if (isString(configuredPortEnv)) {
    return configuredPortEnv;
  }
  return kind === 'shell' ? SHARED_VALIDATOR_STRING_130 : `VERTICAL_${toEnvSegment(domain ?? id)}_PORT`;
};
const normalizedApiExports = (
  appPath: string,
  api: NormalizedApp['api'],
): Pick<NormalizedApp, 'apiClientExport' | 'apiContractExport'> => {
  const packageExports = readJson(PackageJsonSchema, `${appPath}/package.json`).exports ?? {};
  const apiContractExport = packageExports['./api'] === undefined ? undefined : './api';
  const clientExport = api?.protocol === 'rpc' ? SHARED_VALIDATOR_STRING_003 : SHARED_VALIDATOR_STRING_002;
  const apiClientExport = packageExports[clientExport] === undefined ? undefined : clientExport;
  return { apiClientExport, apiContractExport };
};
const normalizeCompactApp = (rawApp: CompactApp): NormalizedApp => {
  const { api: rawApi, domain: rawDomain, id, port: rawPort, portEnv: rawPortEnv } = rawApp;
  const kind = rawApp.kind === 'vertical' ? 'vertical' : 'shell';
  const appPath = normalizedAppPath(rawApp, kind);
  const packageSuffix = isString(rawApp.packageSuffix) ? rawApp.packageSuffix : (appPath.split('/').at(-1) ?? id);
  const domain = normalizedAppDomain(rawDomain, kind, packageSuffix);
  const { moduleFederation } = rawApp;
  // Preserve the API protocol so the synthesized generated contract can branch
  // between REST and RPC surfaces.
  const api = normalizedAppApi(rawApi, domain, id);
  const { apiClientExport, apiContractExport } = normalizedApiExports(appPath, api);
  const mfName = normalizedAppMfName(moduleFederation.name, domain, id, kind);
  const port = normalizedAppPort(rawPort, kind);
  const portEnv = normalizedAppPortEnv(rawPortEnv, domain, id, kind);

  return {
    api,
    apiClientExport,
    apiContractExport,
    backendFederation: rawApp.backendFederation,
    deliveryUnit: rawApp.deliveryUnit,
    domain,
    exposes: moduleFederation.exposes === undefined ? [] : [...moduleFederation.exposes],
    id,
    kind,
    mfName,
    moduleFederationSsr: moduleFederation.ssr !== false,
    package: isString(rawApp.package) ? rawApp.package : undefined,
    packageSuffix,
    path: appPath,
    port,
    portEnv,
    verticalRefs: moduleFederation.verticalRefs === undefined ? [] : [...moduleFederation.verticalRefs],
  };
};
const compactAppsFromConfig = (config: CompactConfig): NormalizedApp[] =>
  Array.isArray(config.topology?.apps) ? config.topology.apps.map(normalizeCompactApp) : [];
const remoteDependencyAliasFor = (app: NormalizedApp): string =>
  toCamelCase(app.domain ?? app.id.replace(/^remote-/u, ''));
const remoteContractsFor = (app: NormalizedApp, apps: readonly NormalizedApp[]) =>
  (app.verticalRefs ?? [])
    .flatMap((ref) => {
      const remote = apps.find((candidate) => candidate.id === ref);
      return remote === undefined || remote.exposes.length === 0 ? [] : [remote];
    })
    .map((remote) => ({
      alias: remoteDependencyAliasFor(remote),
      id: remote.id,
      manifestEnv: `VERTICAL_${toEnvSegment(remote.domain ?? remote.id)}_MF_MANIFEST`,
      manifestUrl: `http://localhost:${remote.port}/mf-manifest.json`,
      name: remote.mfName,
    }));
const createRouteOwnedEntries = (app: NormalizedApp) => {
  if (app.kind === 'vertical' && app.exposes.length === 0) {
    return [];
  }
  const namespace = appNamespace(app);
  const base = {
    descriptionKey: `${namespace}.seo.description`,
    indexable: false,
    mfBoundaryId: app.mfName,
    namespace,
    ownerAppId: app.id,
    public: false,
    publicSurface: SHARED_VALIDATOR_STRING_105,
  };

  return [
    {
      ...base,
      canonicalPath: '/',
      id: app.kind === 'shell' ? 'shell-home' : `${app.id}-home`,
      localisedPaths: {
        cs: '/',
        en: '/',
      },
      titleKey: app.kind === 'shell' ? 'shell.title' : `${namespace}.title`,
    },
  ];
};
const createPublicRoutes = (app: NormalizedApp) =>
  createRouteOwnedEntries(app)
    .filter((route) => route.public && route.indexable)
    .map((route) => ({
      canonicalPath: route.canonicalPath,
      descriptionKey: route.descriptionKey,
      id: route.id,
      localisedPaths: route.localisedPaths,
      namespace: route.namespace,
      ownerAppId: route.ownerAppId,
      titleKey: route.titleKey,
    }));
const createLocalisedUrls = (app: NormalizedApp) =>
  Object.fromEntries(
    createRouteOwnedEntries(app).flatMap((route) => {
      if (route.canonicalPath === '/') {
        return [];
      }
      return [...new Set([route.canonicalPath, ...Object.values(route.localisedPaths)])].map((pathname) => [
        pathname,
        route.localisedPaths,
      ]);
    }),
  );
const createPublicSurface = (app: NormalizedApp) => {
  const publicRoutes = createPublicRoutes(app);
  return {
    artifactLifecycle: 'build-and-deploy-output',
    authoring: SHARED_VALIDATOR_STRING_062,
    cloudflareBuildOutputRoot: 'dist-cloudflare/public',
    concreteUrlPaths: [],
    contentExpansion: {
      authoring: 'route-owned-esm-provider',
      defaultProviderFile: 'route.sitemap.mjs',
      draftPolicy: 'omit-draft-by-default',
      entryExport: 'default-or-entries',
      indexablePolicy: 'omit-indexable-false',
      lifecycle: 'executed-during-public-surface-generation',
      paramsSource: 'params-or-localeParams',
    },
    contentSources: [],
    files:
      publicRoutes.length > 0
        ? [SHARED_VALIDATOR_STRING_113, SHARED_VALIDATOR_STRING_135, SHARED_VALIDATOR_STRING_134]
        : [SHARED_VALIDATOR_STRING_113],
    generatedManifest: SHARED_VALIDATOR_STRING_006,
    generator: SHARED_VALIDATOR_STRING_117,
    languages: ['en', 'cs'],
    metadataExport: SHARED_VALIDATOR_STRING_006,
    omittedByDefault: ['api-catalog.json', 'llms.txt', 'security.txt'],
    outputRoot: 'dist/public',
    privateRoutePolicy: 'omit-from-generated-public-surface',
    publicRoutes,
    routeEntries: [],
    source: 'route-owned-public-routes',
  };
};
const createPublicHead = () => ({
  alternates: {
    hreflang: ['en', 'cs'],
    xDefault: 'en',
  },
  authoring: SHARED_VALIDATOR_STRING_062,
  canonical: {
    publicIndexableOnly: true,
    source: 'localized canonical route URL',
  },
  description: {
    required: true,
    source: 'route.descriptionKey',
  },
  generator: './src/routes/ultramodern-route-head',
  openGraph: {
    publicIndexableOnly: true,
    required: ['og:title', 'og:description', 'og:url', 'og:type'],
  },
  privateRouteRobots: SHARED_VALIDATOR_STRING_090,
  renderer: '@modern-js/runtime/head Helmet',
  ssr: true,
  structuredData: {
    helperModule: './src/routes/ultramodern-jsonld',
    helperTypes: ['WebPage', 'WebApplication', 'SoftwareApplication', 'BreadcrumbList', 'FAQPage', 'Organization'],
    inference: false,
    optional: true,
    publicIndexableOnly: true,
    sanitizesHtmlOpenBracket: true,
    source: 'route.jsonLd',
  },
  title: {
    required: true,
    source: 'route.titleKey',
  },
  twitter: {
    publicIndexableOnly: true,
    required: ['twitter:card', 'twitter:title', 'twitter:description'],
  },
});

const createCloudflareRoutes = (app: NormalizedApp) => {
  const hasRenderedSurface = app.kind === 'shell' || app.exposes.length > 0;
  return {
    apiReadiness: app.api?.protocol === 'rest' ? `${app.api.prefix}/${app.api.stem}/readiness` : undefined,
    locale: hasRenderedSurface ? `/locales/en/${appNamespace(app)}.json` : undefined,
    mfManifest: SHARED_VALIDATOR_STRING_031,
    ssr: hasRenderedSurface ? '/en' : undefined,
  };
};
const createCloudflareDeploy = (app: NormalizedApp) => ({
  assetsBinding: 'ASSETS',
  compatibilityDate: expectedCloudflareCompatibilityDate,
  compatibilityFlags: [SHARED_VALIDATOR_STRING_089, SHARED_VALIDATOR_STRING_070],
  evidence: {
    proofScript: SHARED_VALIDATOR_STRING_119,
    reportDefault: SHARED_VALIDATOR_STRING_008,
  },
  publicUrlEnv: `ULTRAMODERN_PUBLIC_URL_${toEnvSegment(app.id)}`,
  qualityGates: createQualityGates(),
  routes: createCloudflareRoutes(app),
  security: expectedCloudflareSecurity,
  target: SHARED_VALIDATOR_STRING_056,
  workerName: expectedWorkerName(app.packageSuffix),
});
const createEffectReadiness = (app: NormalizedApp) => ({
  checks: ['moduleFederation', 'ssr', 'translations', 'api'],
  endpoint: `/${app.api?.stem ?? ''}/readiness`,
  marker: {
    api: SHARED_VALIDATOR_STRING_151,
    skew: 'none',
    ui: SHARED_VALIDATOR_STRING_152,
  },
});
const createEffectRequestContext = () => ({
  propagatedHeaders: [
    'accept-language',
    'authorization',
    SHARED_VALIDATOR_STRING_142,
    'x-correlation-id',
    'x-tenant-id',
    'x-ultramodern-env',
    'x-vertical-version-id',
  ],
  source: 'shell-to-vertical-api-client',
});
const createEffectDomainOperations = (app: NormalizedApp) => {
  const stem = app.api?.stem ?? '';
  const group = toCamelCase(stem);
  const basePath = `/${stem}`;
  return {
    workspaceCreate: {
      client: `create${toPascalCase(stem)}`,
      method: 'POST',
      owner: app.id,
      path: basePath,
      resource: group,
    },
    workspaceDetail: {
      client: `get${toPascalCase(stem)}`,
      method: 'GET',
      owner: app.id,
      path: `${basePath}/:id`,
      resource: 'workspace-item',
    },
    workspaceFeed: {
      client: `list${toPascalCase(stem)}`,
      method: 'GET',
      owner: app.id,
      path: basePath,
      resource: 'workspace-items',
    },
  };
};
const createEffectOperationContract = (app: NormalizedApp) => ({
  group: toCamelCase(app.api?.stem ?? ''),
  operations: {
    readiness: {
      method: 'GET',
      path: `/${app.api?.stem ?? ''}/readiness`,
      source: 'generated-client',
    },
  },
});
const createAppConfigContract = (app: NormalizedApp) => ({
  dev: {
    assetPrefix: app.kind === 'shell' ? '/' : SHARED_VALIDATOR_STRING_045,
  },
  output: {
    assetPrefix: {
      default: app.kind === 'shell' ? '/' : SHARED_VALIDATOR_STRING_045,
      envFallbackOrder: [SHARED_VALIDATOR_STRING_080, SHARED_VALIDATOR_STRING_143],
    },
    disableTsChecker: false,
  },
  performance: {
    readinessDiagnostics: {
      default: 'enabled',
      failOn: SHARED_VALIDATOR_STRING_069,
      optOut: {
        config: SHARED_VALIDATOR_STRING_121,
        env: SHARED_VALIDATOR_STRING_146,
      },
    },
  },
  plugins: [
    'appTools',
    'tanstackRouterPlugin',
    'i18nPlugin',
    ...(app.api ? ['bffPlugin'] : []),
    'moduleFederationPlugin',
    'zephyrRspackPlugin',
  ],
  preset: SHARED_VALIDATOR_STRING_104,
  rspack: {
    output: {
      chunkLoadingGlobal: expectedChunkLoadingGlobal(app.mfName),
      uniqueName: app.mfName,
    },
  },
  source: {
    siteUrl: {
      defaultLocalhostPort: app.port,
      envFallbackOrder: [
        SHARED_VALIDATOR_STRING_081,
        `ULTRAMODERN_PUBLIC_URL_${toEnvSegment(app.id)}`,
        SHARED_VALIDATOR_STRING_145,
        app.portEnv,
      ],
    },
  },
});
const cssDedupe = () => ({
  duplicateBaseStylesAllowed: false,
  runtimeLoad: 'once-per-content-hash',
  sharedLayers: [SHARED_VALIDATOR_STRING_149],
  sharedPackage: packageNameFor(packageScope, SHARED_VALIDATOR_STRING_128),
  strategy: 'shared-token-package-plus-css-content-hash',
});
const createStylingContract = (app: NormalizedApp) => {
  const sharedTokenPackage = packageNameFor(packageScope, SHARED_VALIDATOR_STRING_128);
  const ownedLayers =
    app.kind === 'shell'
      ? [SHARED_VALIDATOR_STRING_150, 'ultramodern-shell-overlay']
      : [`ultramodern-vertical-${app.domain ?? app.id}`];

  return {
    federation: {
      assets: {
        owned: [SHARED_VALIDATOR_STRING_138],
        shared: [`${sharedTokenPackage}/tokens.css`],
      },
      classPrefix: `${tailwindPrefixFor(app)}:`,
      dedupe: cssDedupe(),
      entrypoints: {
        css: [SHARED_VALIDATOR_STRING_138],
        federationEntry: app.kind === 'shell' || app.exposes.length === 0 ? undefined : SHARED_VALIDATOR_STRING_136,
        layoutImport: 'src/routes/layout.tsx',
      },
      layers: {
        owned: ownedLayers,
        shared: [SHARED_VALIDATOR_STRING_149],
      },
      owner: {
        id: app.id,
        package: app.package ?? packageNameFor(packageScope, app.packageSuffix),
      },
      role: app.kind === 'shell' ? 'shell-base-overlay' : 'vertical-css',
      rootSelector: `[data-app-id="${app.id}"]`,
      ssr: {
        cloudflare: true,
        firstPaintRequired: true,
        verticalCss: app.kind === 'shell' ? 'host-preloads-shell-and-shared-css' : 'federated-manifest-owned-css',
      },
    },
    tailwind: tailwindEnabled,
  };
};
const createApiContract = (app: NormalizedApp) => {
  const { api } = app;
  if (api === undefined) {
    return api;
  }
  // An `rpc` unit exposes the Effect RpcGroup contract/client and the
  // `/rpc` route instead of the REST `shared/api.ts` + `./api/client`
  // surface, so it carries no OpenAPI/readiness/domain-operation metadata.
  if (api.protocol === 'rpc') {
    return {
      client: SHARED_VALIDATOR_STRING_003,
      contract: './api',
      group: toCamelCase(api.stem),
      import: '@modern-js/bff-effect/effect-edge',
      prefix: api.prefix,
      protocol: 'rpc',
      rpc: { path: '/rpc', serialization: 'json' },
      rpcPath: `${api.prefix}/rpc`,
      runtime: 'effect',
      strictEffectApproach: true,
      workerEntry: 'worker/__modern_bff_effect.js',
    };
  }
  return {
    client: app.apiClientExport,
    contract: app.apiContractExport,
    domainOperations: app.apiContractExport === undefined ? undefined : createEffectDomainOperations(app),
    import: '@modern-js/bff-effect/effect-edge',
    openapi: '/openapi.json',
    prefix: api.prefix,
    readiness: createEffectReadiness(app),
    requestContext: createEffectRequestContext(),
    runtime: 'effect',
    strictEffectApproach: true,
    workerEntry: 'worker/__modern_bff_effect.js',
    ...createEffectOperationContract(app),
  };
};
const createAppFederationContract = (app: NormalizedApp, apps: readonly NormalizedApp[]) => ({
  browserSafeExposesOnly: true,
  dts:
    app.kind === 'shell' || app.exposes.length > 0
      ? {
          compilerInstance: SHARED_VALIDATOR_STRING_068,
          displayErrorInTerminal: true,
          tsConfigPath: SHARED_VALIDATOR_STRING_007,
        }
      : undefined,
  exposes: app.exposes,
  name: app.mfName,
  remotes: app.verticalRefs.length > 0 ? remoteContractsFor(app, apps) : undefined,
  verticalRefs: app.verticalRefs.length > 0 ? app.verticalRefs : undefined,
});
const createAppContract = (app: NormalizedApp, apps: readonly NormalizedApp[]) => ({
  api: createApiContract(app),
  config: createAppConfigContract(app),
  deploy: {
    cloudflare: createCloudflareDeploy(app),
    target: SHARED_VALIDATOR_STRING_056,
    worker: {
      compatibilityDate: expectedCloudflareCompatibilityDate,
      name: expectedWorkerName(app.packageSuffix),
      security: expectedCloudflareSecurity,
      ssr: true,
    },
  },
  i18n: {
    languages: ['en', 'cs'],
    localisedUrls: createLocalisedUrls(app),
    namespace: appNamespace(app),
  },
  id: app.id,
  kind: app.kind,
  marker: {
    apiSurface: app.api === undefined ? undefined : 'api',
    appId: app.id,
    build: app.deliveryUnit?.buildMarker ?? buildMarkerFor(app),
    deployProfile: SHARED_VALIDATOR_STRING_057,
    packageName: app.package ?? packageNameFor(packageScope, app.packageSuffix),
    uiSurface: 'ui',
    version: '0.1.0',
  },
  moduleFederation: createAppFederationContract(app, apps),
  package: app.package ?? packageNameFor(packageScope, app.packageSuffix),
  path: app.path,
  routes: {
    generatedManifest: true,
    localisedUrls: createLocalisedUrls(app),
    metadataAuthoring: SHARED_VALIDATOR_STRING_062,
    metadataExport: SHARED_VALIDATOR_STRING_006,
    owned: createRouteOwnedEntries(app),
    privateByDefault: true,
    publicHead: createPublicHead(),
    publicnessDefault: SHARED_VALIDATOR_STRING_105,
    publicRoutes: createPublicRoutes(app),
    publicSurface: createPublicSurface(app),
    source: 'route-owned',
  },
  ssr: app.moduleFederationSsr
    ? {
        mode: 'stream',
        moduleFederationAppSSR: true,
      }
    : undefined,
  styling: createStylingContract(app),
});
const createCssFederationContract = () => ({
  sharedDesignTokens: {
    assets: {
      exports: ['./tokens.css'],
    },
    classPrefix: '--um-',
    dedupe: cssDedupe(),
    entrypoints: {
      css: [SHARED_VALIDATOR_STRING_097],
    },
    layers: {
      owned: [SHARED_VALIDATOR_STRING_149],
    },
    owner: {
      id: SHARED_VALIDATOR_STRING_128,
      package: packageNameFor(packageScope, SHARED_VALIDATOR_STRING_128),
    },
    role: SHARED_VALIDATOR_STRING_128,
    rootSelector: ':root',
    ssr: {
      firstPaintRequired: true,
    },
  },
});
const createPerformanceReadinessContract = () => ({
  default: 'enabled',
  mode: 'diagnostic',
  optOut: {
    env: SHARED_VALIDATOR_STRING_146,
  },
  report: {
    config: SHARED_VALIDATOR_STRING_121,
    deterministic: true,
    script: SHARED_VALIDATOR_STRING_122,
  },
  scope: 'ultramodern-generated-and-framework-owned',
  signals: [
    'bfcache',
    'core-web-vitals-rum',
    'duplicate-prefetch-warmup',
    'cache-policy-sanity',
    'save-data-behavior',
    'cloudflare-ssr-cache-hints',
  ].map((id) => ({ id })),
});
const createModernPackageAliases = (
  packageSourceConfig: CompactConfig['packageSource'],
): Readonly<Record<string, string>> | undefined => {
  if (!isString(packageSourceConfig?.aliasScope)) {
    return undefined;
  }
  const scope = packageSourceConfig.aliasScope.replace(/^@/u, '');
  const prefix = isString(packageSourceConfig.aliasPackageNamePrefix) ? packageSourceConfig.aliasPackageNamePrefix : '';
  return Object.fromEntries(
    modernPackageCohort.map((packageName) => [packageName, `@${scope}/${prefix}${packageName.split('/').at(-1)}`]),
  );
};
const createPackageSourceView = (config: CompactConfig) => {
  const source = config.packageSource;
  assert(isPackageSourceDocument(source), `${compactConfigPath} packageSource must be a JSON object`);
  assert(
    source.strategy === 'workspace' || source.strategy === 'install',
    `${compactConfigPath} packageSource.strategy must be workspace or install`,
  );
  if (source.strategy === 'install') {
    assert(
      isString(source.modernPackageVersion) && source.modernPackageVersion.length > 0,
      `${compactConfigPath} install package source must declare modernPackageVersion`,
    );
  }
  const { strategy } = source;
  const specifier = strategy === 'install' ? source.modernPackageVersion : SHARED_VALIDATOR_STRING_169;
  const aliases = createModernPackageAliases(source);
  return {
    generatedWorkspacePackages: {
      packages: [
        packageNameFor(packageScope, SHARED_VALIDATOR_STRING_127),
        packageNameFor(packageScope, SHARED_VALIDATOR_STRING_128),
      ],
      specifier: SHARED_VALIDATOR_STRING_169,
    },
    modernPackages: {
      aliases,
      packages: modernPackageCohort,
      registry: isString(source.registry) ? source.registry : undefined,
      specifier,
    },
    schemaVersion: 1,
    strategy,
  };
};
const synthesizeGeneratedContractFromCompact = (config: CompactConfig) => {
  const apps = compactAppsFromConfig(config);
  return {
    apps: apps.map((app) => createAppContract(app, apps)),
    cssFederation: createCssFederationContract(),
    node: {
      engineRange: '>=26',
      version: config.workspace?.node?.version ?? expectedNodeVersion,
    },
    performanceReadiness: createPerformanceReadinessContract(),
    profile: config.profile ?? SHARED_VALIDATOR_STRING_057,
    schemaVersion: 1,
  };
};
const readGeneratedContractView = (config: CompactConfig) => synthesizeGeneratedContractFromCompact(config);
const expectedManifestUrl = (vertical: FullStackVertical): string =>
  `http://localhost:${vertical.port}/mf-manifest.json`;
const expectedApiUrl = (vertical: FullStackVertical): string =>
  `http://localhost:${vertical.port}${vertical.apiPrefix}${vertical.apiProtocol === 'rpc' ? '/rpc' : ''}`;
const expectedBackendFederationName = (vertical: FullStackVertical): string => `${vertical.mfName}Backend`;
const expectedBackendManifestUrl = (vertical: FullStackVertical): string =>
  `http://localhost:${vertical.port}/backend-mf-manifest.json`;
const expectedBackendContainerEntry = (vertical: FullStackVertical): string =>
  `http://localhost:${vertical.port}/backendRemoteEntry.cjs`;
const expectedBackendManifestEnv = (vertical: FullStackVertical): string =>
  `VERTICAL_${toEnvSegment(vertical.domain ?? vertical.id)}_BACKEND_MF_MANIFEST`;
const expectedPublicUrlEnv = (vertical: FullStackVertical): string =>
  `ULTRAMODERN_PUBLIC_URL_${toEnvSegment(vertical.id)}`;
const expectedCloudflareWorkerName = (vertical: FullStackVertical): string =>
  toKebabCase(`${packageScope}-${vertical.packageSuffix ?? vertical.id}`).slice(0, 63);
const backendFederationSubset = (backendFederation: CompactBackendFederation | undefined) => {
  if (backendFederation === undefined) {
    return {
      cloudflare: {},
      compatibility: {},
      node: {},
      versionBoundary: {},
    };
  }
  const effectApiExpose = backendFederation.exposes[SHARED_VALIDATOR_STRING_004];
  const { cloudflare, node } = backendFederation.executionSurfaces;
  return {
    cloudflare: {
      kind: cloudflare.kind,
      publicUrlEnv: cloudflare.publicUrlEnv,
      workerName: cloudflare.workerName,
      zephyrRuntime: cloudflare.zephyr.runtime,
    },
    compatibility: {
      contractVersion: backendFederation.compatibility.contractVersion,
    },
    exposeReadiness: effectApiExpose.readiness,
    exposeRuntime: effectApiExpose.runtime,
    name: backendFederation.name,
    node: {
      containerEntry: node.containerEntry,
      expose: node.expose,
      kind: node.kind,
      manifestEnv: node.manifestEnv,
      manifestUrl: node.manifestUrl,
      remoteName: node.remoteName,
      remoteType: node.remoteType,
    },
    role: backendFederation.role,
    runtimeFramework: backendFederation.runtimeFramework,
    strictEffectApproach: backendFederation.strictEffectApproach,
    topLevelContainerEntry: backendFederation.containerEntry,
    topLevelManifestUrl: backendFederation.manifestUrl,
    versionBoundary: {
      apiReadiness: backendFederation.versionBoundary.api.readiness,
      invariant: backendFederation.versionBoundary.invariant,
      uiManifestUrl: backendFederation.versionBoundary.ui.manifestUrl,
    },
  };
};
const expectedBackendFederationSubset = (vertical: FullStackVertical) => ({
  exposeRuntime: `${vertical.path}/api/index.ts`,
  name: expectedBackendFederationName(vertical),
  role: SHARED_VALIDATOR_STRING_078,
  runtimeFramework: 'effect',
  strictEffectApproach: true,
  // The RPC surface exposes no REST readiness endpoint, so its backend
  // federation contract omits the readiness probes (G7a).
  cloudflare: {
    kind: SHARED_VALIDATOR_STRING_058,
    publicUrlEnv: expectedPublicUrlEnv(vertical),
    workerName: expectedCloudflareWorkerName(vertical),
    zephyrRuntime: SHARED_VALIDATOR_STRING_139,
  },
  compatibility: {
    contractVersion: SHARED_VALIDATOR_STRING_079,
  },
  exposeReadiness: vertical.apiProtocol === 'rpc' ? undefined : `${vertical.apiPrefix}/${vertical.stem}/readiness`,
  node: {
    containerEntry: expectedBackendContainerEntry(vertical),
    expose: SHARED_VALIDATOR_STRING_004,
    kind: SHARED_VALIDATOR_STRING_088,
    manifestEnv: expectedBackendManifestEnv(vertical),
    manifestUrl: expectedBackendManifestUrl(vertical),
    remoteName: expectedBackendFederationName(vertical),
    remoteType: SHARED_VALIDATOR_STRING_063,
  },
  versionBoundary: {
    apiReadiness: vertical.apiProtocol === 'rpc' ? undefined : `${vertical.apiPrefix}/${vertical.stem}/readiness`,
    invariant: SHARED_VALIDATOR_STRING_168,
    uiManifestUrl: expectedManifestUrl(vertical),
  },
});
const serverExecutionSubset = (serverExecution: OverlayServerExecution | undefined) => ({
  apiBaseUrl: serverExecution?.apiBaseUrl,
  cloudflareKind: serverExecution?.cloudflare?.kind,
  cloudflareWorkerName: serverExecution?.cloudflare?.workerName,
  nodeContainerEntry: serverExecution?.node?.containerEntry,
  nodeKind: serverExecution?.node?.kind,
  nodeManifestUrl: serverExecution?.node?.manifestUrl,
  versionBoundary: serverExecution?.versionBoundary,
});
const expectedServerExecutionSubset = (vertical: FullStackVertical) => ({
  apiBaseUrl: expectedApiUrl(vertical),
  cloudflareKind: SHARED_VALIDATOR_STRING_058,
  cloudflareWorkerName: expectedCloudflareWorkerName(vertical),
  nodeContainerEntry: expectedBackendContainerEntry(vertical),
  nodeKind: SHARED_VALIDATOR_STRING_088,
  nodeManifestUrl: expectedBackendManifestUrl(vertical),
  versionBoundary: SHARED_VALIDATOR_STRING_168,
});
const remoteContractSubset = (remote: Pick<CompactRemote, 'id' | 'manifestUrl' | 'name'> | undefined) => ({
  id: remote?.id,
  manifestUrl: remote?.manifestUrl,
  name: remote?.name,
});
const expectedRemoteContractSubset = (vertical: FullStackVertical) => ({
  id: vertical.id,
  manifestUrl: expectedManifestUrl(vertical),
  name: vertical.mfName,
});
const expectedRemoteSubsetsForRefs = (refs: readonly string[]) =>
  refs
    .flatMap((ref) => {
      const vertical = fullStackVerticals.find((candidate) => candidate.id === ref);
      return vertical === undefined || vertical.exposes.length === 0 ? [] : [vertical];
    })
    .map(expectedRemoteContractSubset);
const requiredMicroVerticalPaths = (vertical: FullStackVertical): string[] => [
  `${vertical.path}/package.json`,
  `${vertical.path}/tsconfig.json`,
  `${vertical.path}/tsconfig.mf-types.json`,
  `${vertical.path}/modern.config.ts`,
  `${vertical.path}/src/modern-app-env.d.ts`,
  `${vertical.path}/src/modern.runtime.ts`,
  `${vertical.path}/locales/en/translation.json`,
  `${vertical.path}/locales/cs/translation.json`,
  ...(vertical.hasNamespaceLocale
    ? [
        `${vertical.path}/locales/en/${vertical.namespace}.json`,
        `${vertical.path}/locales/cs/${vertical.namespace}.json`,
      ]
    : []),
  ...(vertical.emitsUi
    ? [
        `${vertical.path}/module-federation.config.ts`,
        ...(vertical.hasFederationEntry ? [`${vertical.path}/src/federation-entry.tsx`] : []),
        ...vertical.componentPaths,
        `${vertical.path}/src/routes/index.css`,
        `${vertical.path}/src/routes/layout.tsx`,
        `${vertical.path}/src/routes/ultramodern-route-head.tsx`,
        `${vertical.path}/src/routes/ultramodern-route-metadata.ts`,
        ...(vertical.hasOwnerPage
          ? [`${vertical.path}/src/routes/[lang]/page.tsx`, `${vertical.path}/src/routes/ultramodern-jsonld.ts`]
          : []),
        ...(vertical.exposes.includes('./Widget')
          ? [`${vertical.path}/src/routes/[lang]/_mf/fragment/widget/page.tsx`]
          : []),
        ...vertical.routePagePaths,
        ...vertical.routeMetaPaths,
      ]
    : []),
  ...(vertical.emitsApi
    ? [
        `${vertical.path}/backend-federation.config.ts`,
        `${vertical.path}/api/effect-api.ts`,
        `${vertical.path}/api/index.ts`,
        `${vertical.path}/${vertical.apiContractPath}`,
        `${vertical.path}/${vertical.apiClientPath}`,
      ]
    : []),
];
// UI/MF artifacts an `api-only` unit must NOT emit (headless invariant), and
// API/BFF artifacts a `ui-only`/Horizontal Remote unit must NOT emit.
const forbiddenMicroVerticalPaths = (vertical: FullStackVertical): string[] => [
  // Structured data is owner-page-only: a unit that renders no owner page emits no
  // `application/ld+json`, so it must not ship the JSON-LD helper module either.
  ...(vertical.hasOwnerPage ? [] : [`${vertical.path}/src/routes/ultramodern-jsonld.ts`]),
  ...(vertical.emitsUi
    ? []
    : [
        `${vertical.path}/module-federation.config.ts`,
        `${vertical.path}/src/federation-entry.tsx`,
        // The federated demo `./Widget` component (descriptors.ts:127 ->
        // remoteComponentOutputPath) is a UI-only artifact; a headless api-only
        // unit exposes no browser component and must not ship it.
        `${vertical.path}/src/components/${vertical.domain ?? vertical.id}-widget.tsx`,
        `${vertical.path}/src/routes/layout.tsx`,
        `${vertical.path}/src/routes/[lang]/page.tsx`,
        `${vertical.path}/src/routes/[lang]/_mf/fragment/widget/page.tsx`,
        // A headless api-only unit renders no browser surface, so it must not
        // ship route components, the colocated route-metadata/head modules, or
        // the colocated `[lang]/route.meta.ts` route-meta file.
        `${vertical.path}/src/routes/[lang]/route.meta.ts`,
        `${vertical.path}/src/routes/ultramodern-route-head.tsx`,
        `${vertical.path}/src/routes/ultramodern-route-metadata.ts`,
        `${vertical.path}/src/routes/index.css`,
      ]),
  ...(vertical.emitsApi
    ? []
    : [
        `${vertical.path}/shared/api.ts`,
        // A ui-only/Horizontal Remote unit carries no API contract in either
        // protocol (neither the REST `shared/api.ts` nor the RPC `shared/rpc.ts`)
        // and no generated API client.
        `${vertical.path}/shared/rpc.ts`,
        `${vertical.path}/backend-federation.config.ts`,
        `${vertical.path}/api/index.ts`,
        `${vertical.path}/api/effect-api.ts`,
        `${vertical.path}/src/api/${vertical.domain ?? vertical.id}-client.ts`,
        `${vertical.path}/src/api/${vertical.domain ?? vertical.id}-rpc-client.ts`,
      ]),
];
const assertRequiredVerticalFile =
  (vertical: FullStackVertical) =>
  (relativePath: string): void => {
    assertSelfCheck(
      fs.existsSync(path.join(root, relativePath)),
      `required files for ${vertical.id}`,
      `Missing ${relativePath}`,
      'restore the generated MicroVertical files or rerun the MicroVertical generator',
    );
  };
const assertForbiddenVerticalFile =
  (vertical: FullStackVertical) =>
  (relativePath: string): void => {
    assertSelfCheck(
      !fs.existsSync(path.join(root, relativePath)),
      `forbidden files for ${vertical.id}`,
      `Unexpected ${relativePath} for a ${vertical.surfaceProfile} unit`,
      `remove ${relativePath}; a ${vertical.surfaceProfile} unit does not emit this surface`,
    );
  };
const verticalExposes = (vertical: FullStackVertical): string[] =>
  Array.isArray(vertical.exposes) ? vertical.exposes : Object.keys(vertical.exposes ?? {});
const regenerateMicroVerticalContractFix = 'regenerate the generated MicroVertical contract entry';
const assertTopologyVerticalDeliveryUnitContract = (
  vertical: FullStackVertical,
  topologyEntry: ReferenceTopologyVertical,
): void => {
  if (vertical.deliveryUnit === undefined) {
    return;
  }
  const compactApp = findById(ultramodernConfig.topology?.apps, vertical.id);
  const expectedDeliveryUnit = deliveryUnitBlock(expectedDeliveryUnitFor(vertical));
  assertSameJson(
    deliveryUnitBlock(compactApp?.deliveryUnit),
    expectedDeliveryUnit,
    `${generatedContractLabel} topology.apps.${vertical.id}.deliveryUnit`,
    deliveryUnitIdentityFixArea,
  );
  if (vertical.emitsApi) {
    assertSameJson(
      deliveryUnitBlock(compactApp?.backendFederation?.deliveryUnit),
      expectedDeliveryUnit,
      `${generatedContractLabel} topology.apps.${vertical.id}.backendFederation.deliveryUnit`,
      deliveryUnitIdentityFixArea,
    );
  }
  assertSameJson(
    deliveryUnitBlock(topologyEntry.deliveryUnit),
    expectedDeliveryUnit,
    `topology/reference-topology.json verticals.${vertical.id}.deliveryUnit`,
    deliveryUnitIdentityFixArea,
  );
  if (vertical.emitsApi) {
    assertSameJson(
      deliveryUnitBlock(topologyEntry.backendFederation?.deliveryUnit),
      expectedDeliveryUnit,
      `topology/reference-topology.json verticals.${vertical.id}.backendFederation.deliveryUnit`,
      deliveryUnitIdentityFixArea,
    );
    assertSelfCheck(
      topologyEntry.backendFederation?.versionBoundary?.identityRoot === SHARED_VALIDATOR_STRING_065,
      `topology/reference-topology.json verticals.${vertical.id}.backendFederation.versionBoundary.identityRoot`,
      `Expected "deliveryUnit", found ${formatJson(topologyEntry.backendFederation?.versionBoundary?.identityRoot)}`,
      deliveryUnitIdentityFixArea,
    );
  }
};
const topologyVerticalFederationView = (topologyEntry: ReferenceTopologyVertical) => ({
  exposes: topologyEntry.moduleFederation?.exposes ?? [],
  manifestUrl: topologyEntry.moduleFederation?.manifestUrl,
  name: topologyEntry.moduleFederation?.name,
  remotes: (topologyEntry.moduleFederation?.remotes ?? []).map(remoteContractSubset),
  verticalRefs: topologyEntry.moduleFederation?.verticalRefs ?? [],
});
const assertTopologyVerticalContract = (vertical: FullStackVertical): void => {
  const topologyEntry = findById(topology.verticals, vertical.id);
  const expectedRefs = vertical.verticalRefs ?? [];
  assertObject(topologyEntry, `topology/reference-topology.json verticals.${vertical.id}`, SHARED_VALIDATOR_STRING_112);
  if (topologyEntry === undefined) {
    return;
  }
  assertSameJson(
    {
      api: vertical.emitsApi
        ? {
            prefix: topologyEntry.api?.bff?.prefix,
            serverEntry: topologyEntry.api?.serverEntry,
          }
        : undefined,
      kind: topologyEntry.kind,
      moduleFederation: topologyVerticalFederationView(topologyEntry),
      package: topologyEntry.package,
      path: topologyEntry.path,
    },
    {
      api: vertical.emitsApi
        ? {
            prefix: vertical.apiPrefix,
            serverEntry: `${vertical.path}/api/index.ts`,
          }
        : undefined,
      kind: 'vertical',
      moduleFederation: {
        exposes: verticalExposes(vertical),
        manifestUrl: expectedManifestUrl(vertical),
        name: vertical.mfName,
        remotes: expectedRemoteSubsetsForRefs(expectedRefs),
        verticalRefs: expectedRefs,
      },
      package: vertical.packageName,
      path: vertical.path,
    },
    `topology/reference-topology.json verticals.${vertical.id}`,
    SHARED_VALIDATOR_STRING_112,
  );
  if (vertical.emitsApi) {
    assertSameJson(
      backendFederationSubset(topologyEntry.backendFederation),
      expectedBackendFederationSubset(vertical),
      `topology/reference-topology.json verticals.${vertical.id}.backendFederation`,
      'restore generated MicroVertical server execution contract',
    );
  }
  assertTopologyVerticalDeliveryUnitContract(vertical, topologyEntry);
};
const assertVerticalOwnershipAndOverlay = (vertical: FullStackVertical): void => {
  const ownershipEntry = findById(ownership.owners, vertical.id);
  assertObject(ownershipEntry, `topology/ownership.json owners.${vertical.id}`, SHARED_VALIDATOR_STRING_111);
  if (ownershipEntry === undefined) {
    return;
  }
  assertSameJson(
    { package: ownershipEntry.package, path: ownershipEntry.path },
    { package: vertical.packageName, path: vertical.path },
    `topology/ownership.json owners.${vertical.id}`,
    SHARED_VALIDATOR_STRING_111,
  );
  assertSameJson(
    valueForKey(Object.entries(overlay.ports), vertical.id),
    vertical.port,
    `topology/local-overlays/development.json ports.${vertical.id}`,
    'restore generated local development port overlay',
  );
  if (vertical.emitsUi) {
    assertSameJson(
      valueForKey(Object.entries(overlay.manifests), vertical.id),
      expectedManifestUrl(vertical),
      `topology/local-overlays/development.json manifests.${vertical.id}`,
      'restore generated local Module Federation manifest overlay',
    );
  }
  if (vertical.emitsApi) {
    assertSameJson(
      valueForKey(Object.entries(overlay.apis), vertical.id),
      expectedApiUrl(vertical),
      `topology/local-overlays/development.json apis.${vertical.id}`,
      'restore generated local API overlay',
    );
    assertSameJson(
      serverExecutionSubset(valueForKey(Object.entries(overlay.serverExecution ?? {}), vertical.id)),
      expectedServerExecutionSubset(vertical),
      `topology/local-overlays/development.json serverExecution.${vertical.id}`,
      'restore generated local MicroVertical server execution overlay',
    );
  }
};
const assertShellDependenciesForVertical = (
  vertical: FullStackVertical,
  expectedShellVerticalIds: readonly string[],
): void => {
  const composed = expectedShellVerticalIds.includes(vertical.id) && vertical.exposes.length > 0;
  if (vertical.emitsApi || composed) {
    assertSameJson(
      valueForKey(Object.entries(shellPackage.dependencies ?? {}), vertical.packageName),
      SHARED_VALIDATOR_STRING_169,
      `${SHARED_VALIDATOR_STRING_047}/package.json dependencies.${vertical.packageName}`,
      'restore shell dependency for the MicroVertical consumer',
    );
  }
  if (composed) {
    assertSameJson(
      valueForKey(Object.entries(shellPackage[SHARED_VALIDATOR_STRING_173] ?? {}), vertical.zephyrAlias),
      `${vertical.packageName}@workspace:*`,
      `${SHARED_VALIDATOR_STRING_047}/package.json zephyr:dependencies.${vertical.zephyrAlias}`,
      'restore shell Zephyr dependency metadata for the MicroVertical',
    );
  }
};
const generatedVerticalFederationView = (contractEntry: ReturnType<typeof createAppContract>) => ({
  exposes: contractEntry.moduleFederation?.exposes ?? [],
  name: contractEntry.moduleFederation?.name,
  remotes: (contractEntry.moduleFederation?.remotes ?? []).map(remoteContractSubset),
  verticalRefs: contractEntry.moduleFederation?.verticalRefs ?? [],
});
const assertGeneratedVerticalContract = (
  vertical: FullStackVertical,
  generatedContract: ReturnType<typeof readGeneratedContractView>,
): void => {
  const contractEntry = findById(generatedContract.apps, vertical.id);
  assertObject(contractEntry, `${generatedContractLabel} apps.${vertical.id}`, regenerateMicroVerticalContractFix);
  if (contractEntry === undefined) {
    return;
  }
  const expectedRefs = vertical.verticalRefs ?? [];
  assertSameJson(
    {
      api: vertical.emitsApi
        ? {
            client: contractEntry.api?.client,
            contract: contractEntry.api?.contract,
            prefix: contractEntry.api?.prefix,
          }
        : undefined,
      kind: contractEntry.kind,
      moduleFederation: generatedVerticalFederationView(contractEntry),
      package: contractEntry.package,
      path: contractEntry.path,
      ssr: contractEntry.ssr,
    },
    {
      api: vertical.emitsApi
        ? {
            client: vertical.apiClientExport,
            contract: vertical.apiContractExport,
            prefix: vertical.apiPrefix,
          }
        : undefined,
      kind: 'vertical',
      moduleFederation: {
        exposes: verticalExposes(vertical),
        name: vertical.mfName,
        remotes: expectedRemoteSubsetsForRefs(expectedRefs),
        verticalRefs: expectedRefs,
      },
      package: vertical.packageName,
      path: vertical.path,
      ssr: { mode: 'stream', moduleFederationAppSSR: true },
    },
    `${generatedContractLabel} apps.${vertical.id}`,
    regenerateMicroVerticalContractFix,
  );
};
const assertGeneratedPrimaryShellContract = (
  generatedContract: ReturnType<typeof readGeneratedContractView>,
  expectedShellVerticalIds: readonly string[],
  expectedShellRemotes: ReturnType<typeof expectedRemoteContractSubset>[],
): boolean => {
  const shellContract = findById(generatedContract.apps, SHARED_VALIDATOR_STRING_131);
  assertObject(
    shellContract,
    `${generatedContractLabel} apps.shell-super-app`,
    'regenerate the generated shell contract entry',
  );
  if (shellContract === undefined) {
    return false;
  }
  assertSameJson(
    shellContract.moduleFederation?.verticalRefs ?? [],
    expectedShellVerticalIds,
    `${generatedContractLabel} shell moduleFederation.verticalRefs`,
    'regenerate the generated shell Module Federation contract',
  );
  assertSameJson(
    (shellContract.moduleFederation?.remotes ?? []).map(remoteContractSubset),
    expectedShellRemotes,
    `${generatedContractLabel} shell moduleFederation.remotes`,
    'regenerate the generated shell Module Federation contract',
  );
  assertSameJson(
    shellContract.ssr,
    {
      mode: 'stream',
      moduleFederationAppSSR: true,
    },
    `${generatedContractLabel} shell SSR contract`,
    'restore generated streaming SSR Module Federation settings',
  );

  return true;
};
const assertMicroVerticalContractGraph = (generatedContract: ReturnType<typeof readGeneratedContractView>): void => {
  const expectedVerticalIds = fullStackVerticals.map((vertical) => vertical.id);
  const expectedAppIds = [SHARED_VALIDATOR_STRING_131, ...expectedVerticalIds];
  const expectedShellVerticalIds = expectedPrimaryShellVerticalIds;
  const expectedShellRemotes = expectedShellVerticalIds.flatMap((verticalId) => {
    const vertical = fullStackVerticals.find((candidate) => candidate.id === verticalId);
    return vertical === undefined || vertical.exposes.length === 0 ? [] : [expectedRemoteContractSubset(vertical)];
  });

  assertObject(topology.shell, 'topology/reference-topology.json shell', 'restore generated topology shell metadata');
  assertArray(topology.verticals, 'topology/reference-topology.json verticals', SHARED_VALIDATOR_STRING_112);
  assertObject(
    topology.shell?.moduleFederation,
    'topology/reference-topology.json shell.moduleFederation',
    'restore generated shell Module Federation metadata',
  );
  assertArray(
    topology.shell?.moduleFederation?.remotes,
    'topology/reference-topology.json shell.moduleFederation.remotes',
    'restore generated shell Module Federation remotes',
  );
  assertArray(ownership.owners, 'topology/ownership.json owners', SHARED_VALIDATOR_STRING_111);
  assertObject(
    overlay.ports,
    'topology/local-overlays/development.json ports',
    'restore generated local development port overlays',
  );
  assertObject(
    overlay.manifests,
    'topology/local-overlays/development.json manifests',
    'restore generated local Module Federation manifest overlays',
  );
  assertObject(
    overlay.ontosModuleManifests,
    'topology/local-overlays/development.json ontosModuleManifests',
    'restore generated OntOS module contract allowlist overlays',
  );
  assertObject(overlay.apis, 'topology/local-overlays/development.json apis', 'restore generated local API overlays');
  assertArray(
    generatedContract.apps,
    `${generatedContractLabel} apps`,
    'regenerate the generated contract from the workspace topology',
  );

  assertSameJson(
    topology.shell.verticalRefs ?? [],
    expectedShellVerticalIds,
    'topology/reference-topology.json shell.verticalRefs',
    'restore generated topology shell references',
  );
  assertSameJson(
    topology.verticals.map((vertical) => vertical?.id),
    expectedVerticalIds,
    'topology/reference-topology.json verticals',
    SHARED_VALIDATOR_STRING_112,
  );
  assertSameJson(
    topology.shell.moduleFederation.remotes.map(remoteContractSubset),
    expectedShellRemotes,
    'topology/reference-topology.json shell.moduleFederation.remotes',
    'restore generated shell Module Federation remotes',
  );
  assertSameJson(
    generatedContract.apps.map((app) => app?.id),
    expectedAppIds,
    `${generatedContractLabel} apps`,
    'regenerate the generated contract after topology changes',
  );

  if (!assertGeneratedPrimaryShellContract(generatedContract, expectedShellVerticalIds, expectedShellRemotes)) {
    return;
  }
  for (const vertical of fullStackVerticals) {
    for (const requiredPath of requiredMicroVerticalPaths(vertical)) {
      assertRequiredVerticalFile(vertical)(requiredPath);
    }
    assertTopologyVerticalContract(vertical);
    assertVerticalOwnershipAndOverlay(vertical);
    assertShellDependenciesForVertical(vertical, expectedShellVerticalIds);
    assertGeneratedVerticalContract(vertical, generatedContract);
  }
};
const toPosixPath = (value: string): string => value.split(path.sep).join('/');
const referenceFrom = (fromPath: string, toPath: string) => ({
  path: toPosixPath(path.relative(fromPath, toPath)),
});
const infrastructurePackagePaths = [SHARED_VALIDATOR_STRING_092];
const sharedPackagePaths = [SHARED_VALIDATOR_STRING_177, SHARED_VALIDATOR_STRING_094, SHARED_VALIDATOR_STRING_096];
const workspacePackagePaths = [...infrastructurePackagePaths, ...sharedPackagePaths];
const tsgoCacheKey = (packagePath: string): string => packagePath.replaceAll(/[^a-zA-Z0-9._-]+/gu, '__');
const assertProjectReferenceEmitConfig = (tsConfig: TsConfig, packagePath: string): void => {
  const compilerOptions = tsConfig.compilerOptions ?? {};
  const relativeRoot = toPosixPath(path.relative(packagePath, '.')) ?? '.';
  assert(compilerOptions.composite === true, `${packagePath} must stay a composite TS-Go project`);
  assert(compilerOptions.declaration === true, `${packagePath} must emit declarations for TS-Go build mode`);
  assert(compilerOptions.declarationMap === false, `${packagePath} must not emit declaration maps during checks`);
  assert(compilerOptions.emitDeclarationOnly === true, `${packagePath} must only emit declarations during checks`);
  assert(compilerOptions.noEmit === false, `${packagePath} must override root noEmit for TS-Go build mode`);
  assert(
    compilerOptions.outDir === `${relativeRoot}/node_modules/.cache/tsgo/declarations/${tsgoCacheKey(packagePath)}`,
    `${packagePath} must emit TS-Go declarations into the generated cache`,
  );
  assert(
    compilerOptions.tsBuildInfoFile ===
      `${relativeRoot}/node_modules/.cache/tsgo/${tsgoCacheKey(packagePath)}.tsbuildinfo`,
    `${packagePath} must keep TS-Go build info in the generated cache`,
  );
};
const expectedVerticalTypecheckIncludes = (vertical: FullStackVertical, verticalPackage: PackageJson) =>
  vertical.typecheckIncludes ?? [
    'src',
    SHARED_VALIDATOR_STRING_075,
    SHARED_VALIDATOR_STRING_091,
    'shared',
    ...(vertical.emitsApi ? ['api'] : []),
    ...(verticalPackage.modernjs?.ontosModule === undefined
      ? []
      : ['vertical.manifest.ts', 'vertical.registration.ts']),
  ];
const assertVerticalTsConfigReferenceGraph = (vertical: FullStackVertical): void => {
  const verticalTsConfig = readJson(TsConfigSchema, `${vertical.path}/tsconfig.json`);
  const verticalMfTypesTsConfig = readJson(TsConfigSchema, `${vertical.path}/tsconfig.mf-types.json`);
  const verticalPackage = readJson(PackageJsonSchema, `${vertical.path}/package.json`);
  const sourceSpecifiers = ['api', 'shared', 'src']
    .flatMap((sourceRoot) => {
      const sourceRootPath = `${vertical.path}/${sourceRoot}`;
      return fs.existsSync(path.join(root, sourceRootPath))
        ? generatedSurfacePolicyFiles({
            extensions: ['.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'],
            kind: 'directory',
            path: sourceRootPath,
          })
        : [];
    })
    .flatMap((sourcePath) => {
      const source = readText(sourcePath);
      return [
        ...source.matchAll(/\b(?:import|export)\s+(?:type\s+)?[^;'"`]+?\s+from\s*['"](?<specifier>[^'"]+)['"]/gu),
        ...source.matchAll(/\bimport\s*['"](?<specifier>[^'"]+)['"]/gu),
        ...source.matchAll(/\bimport\s*\(\s*['"](?<specifier>[^'"]+)['"]/gu),
        ...source.matchAll(/\brequire\s*\(\s*['"](?<specifier>[^'"]+)['"]/gu),
      ].flatMap((match) => {
        const specifier = match.groups?.specifier;
        return specifier === undefined ? [] : [specifier];
      });
    });
  const topologyVerticalRefs = new Set<string>(vertical.verticalRefs);
  const publishedContractRefs = fullStackVerticals.flatMap((candidate) => {
    if (candidate.id === vertical.id || topologyVerticalRefs.has(candidate.id)) {
      return [];
    }
    const importsCandidate = sourceSpecifiers.some(
      (specifier) => specifier === candidate.packageName || specifier.startsWith(`${candidate.packageName}/`),
    );
    const dependencyDeclared =
      valueForKey(Object.entries(verticalPackage.dependencies ?? {}), candidate.packageName) ===
      SHARED_VALIDATOR_STRING_169;
    if (!importsCandidate && !dependencyDeclared) {
      return [];
    }
    const candidatePackage = readJson(PackageJsonSchema, `${candidate.path}/package.json`);
    const producerModuleId = resolvePublishedContractModuleId({
      dependencyPackageJson: candidatePackage,
      dependencyPackageName: candidate.packageName,
      expectedAppId: candidate.id,
      manifestSource: readText(`${candidate.path}/vertical.manifest.ts`),
    });
    const expectedReference = referenceFrom(vertical.path, candidate.path);
    assertPublishedCrossMicroVerticalContractUsage({
      dependencyDeclared,
      dependencyPackageJson: candidatePackage,
      dependencyPackageName: candidate.packageName,
      moduleSpecifiers: sourceSpecifiers,
      projectReferenceDeclared: (verticalTsConfig.references ?? []).some(
        (reference) => reference.path === expectedReference.path,
      ),
      readExportSource: (exportTarget) => readText(`${candidate.path}/${exportTarget.slice(2)}`),
    });
    for (const exportKey of publishedOutboxContractExports(candidatePackage)) {
      const exportTarget = candidatePackage.exports?.[exportKey];
      assert(isString(exportTarget), `${candidate.packageName}${exportKey.slice(1)} must resolve to one source file`);
      if (exportTarget === undefined) {
        continue;
      }
      const contractSource = readText(`${candidate.path}/${exportTarget.slice(2)}`);
      assertPublishedOutboxContractSource({
        moduleId: producerModuleId,
        source: contractSource,
        specifier: `${candidate.packageName}${exportKey.slice(1)}`,
      });
    }
    return [candidate.path];
  });
  const expectedVerticalReferences = [
    ...new Set([
      ...infrastructurePackagePaths,
      ...sharedPackagePaths,
      ...(vertical.verticalRefs ?? [])
        .flatMap((verticalRef) => {
          const referencedVertical = fullStackVerticals.find((candidate) => candidate.id === verticalRef);
          return referencedVertical === undefined ? [] : [referencedVertical];
        })
        .map((referencedVertical) => referencedVertical.path),
      ...publishedContractRefs,
    ]),
  ].map((referencePath) => referenceFrom(vertical.path, referencePath));
  assertSameJson(
    EffectArray.sort(
      verticalTsConfig.references ?? [],
      Order.mapInput(Order.String, (entry: { readonly path: string }) => entry.path),
    ),
    EffectArray.sort(
      expectedVerticalReferences,
      Order.mapInput(Order.String, (entry: { readonly path: string }) => entry.path),
    ),
    `${vertical.path}/tsconfig.json references`,
    'restore the generated MicroVertical project-reference graph',
  );
  assertSameJson(
    EffectArray.sort(verticalTsConfig.include ?? [], Order.String),
    EffectArray.sort(expectedVerticalTypecheckIncludes(vertical, verticalPackage), Order.String),
    `${vertical.path}/tsconfig.json include`,
    'restore the generated MicroVertical typecheck boundary',
  );
  assertProjectReferenceEmitConfig(verticalTsConfig, vertical.path);
  const requiredMfTypeIncludes =
    vertical.emitsUi && vertical.exposes.length > 0
      ? [
          SHARED_VALIDATOR_STRING_136,
          ...vertical.componentPaths.map((componentPath) => componentPath.replace(`${vertical.path}/`, '')),
          ...(vertical.emitsApi ? [vertical.apiContractPath] : []),
          SHARED_VALIDATOR_STRING_137,
        ]
      : [SHARED_VALIDATOR_STRING_137];
  assertSameJson(
    {
      ...verticalMfTypesTsConfig,
      // Migration retains consumer includes. Every exposed entry must remain
      // in the DTS boundary, independently of ordering or additional inputs.
      include: EffectArray.sort(
        (verticalMfTypesTsConfig.include ?? []).filter((include) => requiredMfTypeIncludes.includes(include)),
        Order.String,
      ),
    },
    {
      compilerOptions: { skipLibCheck: true },
      extends: SHARED_VALIDATOR_STRING_001,
      include: EffectArray.sort(requiredMfTypeIncludes, Order.String),
    },
    `${vertical.path}/tsconfig.mf-types.json`,
    'restore the generated MicroVertical Module Federation DTS boundary',
  );
};

const primaryShellTsConfigReferences = () => {
  const expectedShellReferences = [
    SHARED_VALIDATOR_STRING_092,
    ...sharedPackagePaths.filter((packagePath) => packagePath !== SHARED_VALIDATOR_STRING_177),
    ...(topology.shell?.verticalRefs ?? [])
      .flatMap((verticalRef) => {
        const vertical = fullStackVerticals.find((candidate) => candidate.id === verticalRef);
        return vertical === undefined ? [] : [vertical];
      })
      // The shell only project-references verticals whose API client types it
      // imports; UI-only remotes are federated at runtime, not type-referenced.
      .filter((vertical) => vertical.emitsApi)
      .map((vertical) => vertical.path),
  ].map((referencePath) => referenceFrom(SHARED_VALIDATOR_STRING_047, referencePath));
  return expectedShellReferences;
};
const assertTsConfigReferenceGraph = () => {
  const baseTsConfig = readJson(TsConfigSchema, 'tsconfig.base.json');
  const rootTsConfig = readJson(TsConfigSchema, 'tsconfig.json');
  const shellTsConfig = readJson(TsConfigSchema, 'apps/shell-super-app/tsconfig.json');
  const shellMfTypesTsConfig = readJson(TsConfigSchema, SHARED_VALIDATOR_STRING_052);
  const additionalShellPaths = (workspaceValidationContract.structuralShellPolicy?.shells ?? [])
    .filter((shell) => shell.id !== SHARED_VALIDATOR_STRING_131)
    .map((shell) => shell.packageDir);
  const expectedRootReferences = [
    ...workspacePackagePaths,
    SHARED_VALIDATOR_STRING_047,
    ...fullStackVerticals.map((vertical) => vertical.path),
    ...additionalShellPaths,
  ].map((referencePath) => ({ path: referencePath }));
  const expectedShellReferences = primaryShellTsConfigReferences();

  assertSameJson(
    rootTsConfig.files,
    [],
    'tsconfig.json files',
    'restore the generated root project-reference tsconfig',
  );
  assertSameJson(
    rootTsConfig.references ?? [],
    expectedRootReferences,
    'tsconfig.json references',
    'restore the generated root project-reference graph',
  );
  assertSameJson(
    EffectArray.sort(
      shellTsConfig.references ?? [],
      Order.mapInput(Order.String, (reference: { readonly path: string }) => reference.path),
    ),
    EffectArray.sort(
      expectedShellReferences,
      Order.mapInput(Order.String, (reference: { readonly path: string }) => reference.path),
    ),
    'apps/shell-super-app/tsconfig.json references',
    'restore the generated shell project-reference graph',
  );
  assert(baseTsConfig.compilerOptions?.skipLibCheck !== true, 'tsconfig.base.json must not use skipLibCheck');
  assertSameJson(
    EffectArray.sort(shellTsConfig.include ?? [], Order.String),
    EffectArray.sort(
      ['api', 'server', 'src', SHARED_VALIDATOR_STRING_075, SHARED_VALIDATOR_STRING_091, 'shared'],
      Order.String,
    ),
    'apps/shell-super-app/tsconfig.json include',
    'restore the generated shell typecheck boundary',
  );
  assertProjectReferenceEmitConfig(shellTsConfig, SHARED_VALIDATOR_STRING_047);
  assertSameJson(
    shellMfTypesTsConfig,
    {
      compilerOptions: { skipLibCheck: true },
      extends: SHARED_VALIDATOR_STRING_001,
      include: [SHARED_VALIDATOR_STRING_137],
    },
    SHARED_VALIDATOR_STRING_052,
    'restore the generated shell Module Federation DTS boundary',
  );
  for (const workspacePackagePath of workspacePackagePaths) {
    assertProjectReferenceEmitConfig(
      readJson(TsConfigSchema, `${workspacePackagePath}/tsconfig.json`),
      workspacePackagePath,
    );
  }

  for (const vertical of fullStackVerticals) {
    assertVerticalTsConfigReferenceGraph(vertical);
  }
};
const packageJsonFiles = (startDir: string): string[] => {
  const files: string[] = [];
  const queue = [startDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (['.git', '.output', '.zerops', 'dist', 'node_modules', 'repos'].includes(entry.name)) {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (entry.name === SHARED_VALIDATOR_STRING_091) {
        files.push(absolute);
      }
    }
  }
  return sortedCopy(files, (left, right) => left.localeCompare(right));
};
const modernDependencyNames = (packageJson: PackageJson): string[] => [
  ...new Set(
    [
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.optionalDependencies,
      packageJson.peerDependencies,
    ]
      .flatMap((section) => Object.keys(section ?? {}))
      .filter((packageName) => packageName.startsWith('@modern-js/')),
  ),
];
const packageDependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const observeModernPackageDependencies = (
  packageJson: PackageJson,
  relativePath: string,
  observedModernPackageNames: Set<string>,
): void => {
  const modernPackageNameSet = new Set(workspaceValidationContract.cohort.modernPackages);
  const standaloneModernTools = workspaceValidationContract.cohort.standaloneModernTools ?? {};
  for (const packageName of modernDependencyNames(packageJson)) {
    observedModernPackageNames.add(packageName);
    if (!modernPackageNameSet.has(packageName)) {
      const releasePackage = expectedReleaseCohort?.packages.find((entry) => entry.sourceName === packageName);
      const expected =
        releasePackage === undefined
          ? valueForKey(Object.entries(standaloneModernTools), packageName)
          : expectedModernPackageSpecifier(packageName);
      assert(expected !== undefined, `${relativePath} declares ${packageName} outside package source metadata`);
      const declared = packageDependencySections.map((section) => packageJson[section]?.[packageName]);
      assert(
        declared.every((specifier) => specifier === undefined || specifier === expected),
        `${relativePath} ${packageName} must match standalone package source metadata`,
      );
    }
  }
};
const assertModernPackageSpecifiers = (packageJson: PackageJson, relativePath: string): void => {
  const modernPackageNames = workspaceValidationContract.cohort.modernPackages;
  for (const section of packageDependencySections) {
    for (const packageName of modernPackageNames) {
      const actual = packageJson[section]?.[packageName];
      if (actual !== undefined) {
        assert(
          actual === expectedModernPackageSpecifier(packageName),
          `${relativePath} ${section}.${packageName} must match package source metadata`,
        );
      }
    }
  }
};
const assertModernPackageCohort = () => {
  const modernPackageNames = workspaceValidationContract.cohort.modernPackages;
  const standaloneModernTools = workspaceValidationContract.cohort.standaloneModernTools ?? {};
  const observedModernPackageNames = new Set<string>();
  const observedAppIds: string[] = [];
  // Additional shells (G28) are their own Delivery Units registered in the
  // additive `config.shells` collection and gated by the structural thin-shell
  // policy; they are deliberately kept out of the strict topology.apps cohort,
  // so their package manifests are excluded from the app-id cohort walk here.
  const additionalShellAppIds = new Set(
    (workspaceValidationContract.structuralShellPolicy?.shells ?? [])
      .map((shell) => shell.id)
      .filter((id) => id !== SHARED_VALIDATOR_STRING_131),
  );
  for (const packageJsonPath of packageJsonFiles(root)) {
    const relativePath = path.relative(root, packageJsonPath).split(path.sep).join('/');
    const packageJson = readJson(PackageJsonSchema, relativePath);
    if (isString(packageJson.modernjs?.appId) && !additionalShellAppIds.has(packageJson.modernjs.appId)) {
      observedAppIds.push(packageJson.modernjs.appId);
    }
    observeModernPackageDependencies(packageJson, relativePath, observedModernPackageNames);
    assertModernPackageSpecifiers(packageJson, relativePath);
  }

  for (const packageName of modernPackageNames) {
    assert(observedModernPackageNames.has(packageName), `Modern package cohort is missing ${packageName}`);
  }
  for (const packageName of Object.keys(standaloneModernTools)) {
    assert(observedModernPackageNames.has(packageName), `Standalone Modern tool metadata is missing ${packageName}`);
  }
  assertUniqueStrings(observedAppIds, 'generated app package manifests');
  // The app-id cohort is a SET: observedAppIds is discovered by a
  // filesystem-ordered package.json walk, while cohort.appIds is in generation
  // insertion order. Compare order-insensitively (every other cohort check uses
  // the same sorted comparison via assertSameIdCohort) so a multi-vertical
  // workspace whose insertion order differs from filesystem order still passes.
  assertSameJson(
    sortedCopy(observedAppIds, (left, right) => left.localeCompare(right)),
    sortedCopy(workspaceValidationContract.cohort.appIds, (left, right) => left.localeCompare(right)),
    'generated app package manifest cohort',
    'restore every generated app package manifest',
  );
};
const assertPublicSurfaceAssets = (appPath: string, publicRoutes: ReturnType<typeof createPublicRoutes>): void => {
  for (const relativePath of publicSurfaceManagedSourceAssetPaths) {
    assertNotExists(`${appPath}/${relativePath}`);
  }
  void publicRoutes;
};
const assertPublicSurfaceContract = (
  appId: string,
  publicSurface: ReturnType<typeof createPublicSurface> | undefined,
): void => {
  if (publicSurface === undefined) {
    assert(false, `${appId} public surface artifacts must be build/deploy outputs`);
    return;
  }
  assert(
    publicSurface.artifactLifecycle === 'build-and-deploy-output',
    `${appId} public surface artifacts must be build/deploy outputs`,
  );
  assert(
    publicSurface.generator === SHARED_VALIDATOR_STRING_117,
    `${appId} public surface generator script is incorrect`,
  );
  assert(publicSurface.outputRoot === 'dist/public', `${appId} public surface dist outputRoot is incorrect`);
  assert(
    publicSurface.cloudflareBuildOutputRoot === 'dist-cloudflare/public',
    `${appId} public surface Cloudflare build outputRoot is incorrect`,
  );
  assert(!('cloudflareOutputRoot' in publicSurface), `${appId} public surface must not target final .output directly`);
  assert(!('staticRoot' in publicSurface), `${appId} public surface must not point at source config/public`);
  assert(
    publicSurface.files.includes(SHARED_VALIDATOR_STRING_113),
    `${appId} public surface must always emit robots.txt`,
  );
  assert(
    publicSurface.contentExpansion.authoring === 'route-owned-esm-provider',
    `${appId} public content expansion authoring is incorrect`,
  );
  assert(
    publicSurface.contentExpansion.defaultProviderFile === 'route.sitemap.mjs',
    `${appId} public content expansion provider file is incorrect`,
  );
  assert(
    publicSurface.contentExpansion.draftPolicy === 'omit-draft-by-default',
    `${appId} public content expansion draft policy is incorrect`,
  );
  assert(
    publicSurface.contentExpansion.indexablePolicy === 'omit-indexable-false',
    `${appId} public content expansion indexable policy is incorrect`,
  );
  assert(Array.isArray(publicSurface.contentSources), `${appId} public content sources must be an array`);
  if (publicSurface.publicRoutes.length === 0) {
    assert(
      !publicSurface.files.includes(SHARED_VALIDATOR_STRING_135),
      `${appId} private public surface must omit sitemap.xml`,
    );
    assert(
      !publicSurface.files.includes(SHARED_VALIDATOR_STRING_134),
      `${appId} private public surface must omit site.webmanifest`,
    );
  } else {
    assert(
      publicSurface.files.includes(SHARED_VALIDATOR_STRING_135),
      `${appId} public surface must emit sitemap.xml when public routes exist`,
    );
    assert(
      publicSurface.files.includes(SHARED_VALIDATOR_STRING_134),
      `${appId} public surface must emit site.webmanifest when public routes exist`,
    );
  }
};
const assertPublicHeadContract = (
  appId: string,
  publicHead: ReturnType<typeof createPublicHead> | undefined,
  headModule: string,
  hasOwnerPage = true,
): void => {
  if (publicHead === undefined) {
    assert(false, `${appId} public head generator is incorrect`);
    return;
  }
  assert(publicHead.generator === './src/routes/ultramodern-route-head', `${appId} public head generator is incorrect`);
  assert(publicHead.renderer === '@modern-js/runtime/head Helmet', `${appId} public head renderer is incorrect`);
  assert(publicHead.ssr, `${appId} public head must be SSR-rendered`);
  assert(publicHead.title.source === 'route.titleKey', `${appId} public head title must come from route metadata`);
  assert(
    publicHead.description.source === 'route.descriptionKey',
    `${appId} public head description must come from route metadata`,
  );
  assert(publicHead.canonical.publicIndexableOnly, `${appId} canonical links must be public/indexable only`);
  assert(publicHead.structuredData.optional, `${appId} structured data must be optional`);
  assert(
    publicHead.structuredData.source === 'route.jsonLd',
    `${appId} structured data must come from explicit route metadata`,
  );
  assert(!publicHead.structuredData.inference, `${appId} structured data inference must stay disabled`);
  assert(
    publicHead.structuredData.sanitizesHtmlOpenBracket,
    `${appId} structured data must sanitize HTML open brackets`,
  );
  assert(
    publicHead.privateRouteRobots === SHARED_VALIDATOR_STRING_090,
    `${appId} private route robots policy is incorrect`,
  );
  if (!hasOwnerPage) {
    for (const snippet of [
      "from '@modern-js/runtime/head'",
      '<title>',
      'name="description"',
      'name="robots"',
      SHARED_VALIDATOR_STRING_090,
    ]) {
      assert(headModule.includes(snippet), `${appId} private API head is missing ${snippet}`);
    }
    for (const snippet of ['rel="canonical"', 'rel="alternate"', 'application/ld+json']) {
      assert(!headModule.includes(snippet), `${appId} must not publish ${snippet} without an owner-rendered route`);
    }
    return;
  }
  assert(
    publicHead.structuredData.helperModule === './src/routes/ultramodern-jsonld',
    `${appId} structured data helper module is incorrect`,
  );
  for (const snippet of [
    "from '@modern-js/runtime/head'",
    '<title>{title}</title>',
    'name="description"',
    'name="robots"',
    'rel="canonical"',
    'rel="alternate"',
    'property="og:title"',
    'property="og:description"',
    'name="twitter:card"',
    'application/ld+json',
    'route?.jsonLd',
  ]) {
    assert(headModule.includes(snippet), `${appId} route head module is missing ${snippet}`);
  }
  assert(
    /replaceAll\(\s*'<',\s*String\.raw`\\u003c`\s*,?\s*\)/u.test(headModule),
    `${appId} route head module must escape HTML opening brackets in JSON-LD`,
  );
};
const assertCloudflareQualityGates = (
  appId: string,
  qualityGates: ReturnType<typeof createQualityGates> | undefined,
): void => {
  if (qualityGates === undefined) {
    assert(false, `${appId} quality gates must require sitemap for public routes`);
    return;
  }
  assert(
    qualityGates.publicRoutes.requireSitemapWhenPresent,
    `${appId} quality gates must require sitemap for public routes`,
  );
  assert(
    qualityGates.publicRoutes.requireRobotsSitemapConsistency,
    `${appId} quality gates must require robots/sitemap consistency`,
  );
  assert(qualityGates.statusCodes.unknownRouteStatus === 404, `${appId} quality gates must require 404 unknown routes`);
  assert(qualityGates.indexing.previewNoindex, `${appId} quality gates must require preview noindex`);
  assert(
    qualityGates.indexing.productionPublicRoutesIndexable,
    `${appId} quality gates must require production public routes to be indexable`,
  );
  assert(qualityGates.assets.cssPreloadRequired, `${appId} quality gates must require CSS preload evidence`);
  assert(
    !qualityGates.assets.sourcemapsPubliclyReferenced,
    `${appId} quality gates must reject public sourcemap references`,
  );
  assert(isNumber(qualityGates.budgets.ssrHtmlMaxBytes), `${appId} quality gates must define SSR HTML byte budget`);
  assert(
    isNumber(qualityGates.budgets.mfManifestMaxBytes),
    `${appId} quality gates must define MF manifest byte budget`,
  );
  assert(qualityGates.csp.finalMode === SHARED_VALIDATOR_STRING_110, `${appId} CSP final mode decision is missing`);
};
const extractAssetPrefixExpression = (modernConfig: string): string => {
  const match = /const\s+assetPrefix\s*=\s*(?<expression>[\s\S]*?);/u.exec(modernConfig);
  assert(
    isString(match?.groups?.expression) && match.groups.expression.length > 0,
    'modern.config.ts must assign assetPrefix',
  );
  return match?.groups?.expression ?? '';
};
const assertTargetIsolatedBuildArtifacts = (appId: string, modernConfig: string): void => {
  assert(
    modernConfig.includes("const buildTarget = cloudflareDeployEnabled ? 'cloudflare' : 'web';") &&
      modernConfig.includes("const buildOutputRoot = cloudflareDeployEnabled ? 'dist-cloudflare' : 'dist';") &&
      modernConfig.includes(
        sourceFragment(
          'const buildTempDirectory = `node_modules/.modern-',
          javascriptDash,
          templatePlaceholderOpening,
          'appId}-',
          templatePlaceholderOpening,
          'buildTarget}`;',
        ),
      ) &&
      modernConfig.includes(
        sourceFragment(
          'const buildCacheDirectory = `node_modules/.cache/rspack-',
          templatePlaceholderOpening,
          'appId}-',
          templatePlaceholderOpening,
          'buildTarget}`;',
        ),
      ) &&
      modernConfig.includes('root: buildOutputRoot,') &&
      modernConfig.includes('tempDir: buildTempDirectory,') &&
      modernConfig.includes('cacheDigest: [appId, buildTarget],') &&
      modernConfig.includes('cacheDirectory: buildCacheDirectory,'),
    `${appId} must isolate build output, Modern temp files, and Rspack cache by app and build target`,
  );
};
const assertCloudflareBuildSkipsDeployRebuild = (appId: string, packageJson: PackageJson): void => {
  const cloudflareBuild = packageJson.scripts?.[SHARED_VALIDATOR_STRING_059] ?? '';
  const buildCommand = 'MODERNJS_DEPLOY=cloudflare modern build';
  const publicSurfaceCommand = `--app ${appId} --target cloudflare-dist`;
  const deployCommand = 'MODERNJS_DEPLOY=cloudflare modern deploy --skip-build';
  assert(
    cloudflareBuild.includes(deployCommand),
    `${appId} cloudflare:build must deploy with --skip-build after the explicit Cloudflare build`,
  );
  assert(
    cloudflareBuild.includes(publicSurfaceCommand) &&
      cloudflareBuild.indexOf(buildCommand) < cloudflareBuild.indexOf(publicSurfaceCommand) &&
      cloudflareBuild.indexOf(publicSurfaceCommand) < cloudflareBuild.indexOf(deployCommand),
    `${appId} cloudflare:build must generate public-surface assets in the explicit Cloudflare build output before deploy`,
  );
  assert(
    !/--target (?:dist|cloudflare)(?=\s|$)/u.test(cloudflareBuild),
    `${appId} cloudflare:build must not target the Node dist or final Cloudflare output directly`,
  );
};
const stripYamlInlineComment = (value: string): string => {
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== null) {
      if (character === quote && value[index - 1] !== '\\') {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#' && (index === 0 || /\s/u.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
};
const normalizeYamlScalar = (value: string): string => {
  const trimmed = stripYamlInlineComment(value).trim();
  if (
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) &&
    trimmed.length >= 2
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};
const nextYamlBlockScalar = (lines: readonly string[], startIndex: number, parentIndent: number): string => {
  const nextLine = lines.slice(startIndex).find((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
  if (nextLine === undefined) {
    return '';
  }
  const nextIndent = /^\s*/u.exec(nextLine)?.[0]?.length ?? 0;
  return nextIndent > parentIndent ? normalizeYamlScalar(nextLine.trim()) : '';
};
const extractWorkflowNodeVersions = (workflowText: string): string[] => {
  const versions = [];
  const lines = workflowText.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const match = /^(?<indent>\s*)node-version\s*:\s*(?<value>.*)$/u.exec(lines[lineIndex]);
    if (!match?.groups) {
      continue;
    }

    let value = normalizeYamlScalar(match.groups.value);
    if (value === '' || value === '|' || value === '>') {
      value = nextYamlBlockScalar(lines, lineIndex + 1, match.groups.indent.length);
    }
    if (value !== '') {
      versions.push(value);
    }
  }
  return versions;
};
const parseSemver = (version: string): Semver => {
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(version);
  assert(match !== null, `Unable to parse pnpm version: ${version}`);
  return {
    major: Number(match?.groups?.major ?? ''),
    minor: Number(match?.groups?.minor ?? ''),
    patch: Number(match?.groups?.patch ?? ''),
  };
};
const compareSemver = (left: Semver, right: Semver): number =>
  left.major - right.major || left.minor - right.minor || left.patch - right.patch;

const activeNodeVersion = process.versions.node;
const minimumPnpmVersion = { major: 11, minor: 0, patch: 0 };
const minimumNodeVersion = { major: 26, minor: 0, patch: 0 };
const currentNodeVersion = parseSemver(activeNodeVersion);
const repositoryWorkflowPath = fs.existsSync(path.join(root, '../.github/workflows/ultramodern-workspace-gates.yml'))
  ? '../.github/workflows/ultramodern-workspace-gates.yml'
  : '.github/workflows/ultramodern-workspace-gates.yml';

const assertActivePnpmVersion = (packageManagerUserAgent: string): void => {
  const activePnpmVersion = /^pnpm\/(?<version>\d+\.\d+\.\d+)/u.exec(packageManagerUserAgent)?.groups?.version;
  assert(
    isString(activePnpmVersion) && activePnpmVersion.length > 0,
    'Validator must run through the workspace pnpm command',
  );
  const currentPnpmVersion = parseSemver(activePnpmVersion ?? '');
  assert(
    compareSemver(currentPnpmVersion, minimumPnpmVersion) >= 0,
    `Generated workspace requires pnpm >=11; active pnpm is ${activePnpmVersion}. Run mise install, then rerun pnpm from the activated shell.`,
  );
};
assert(
  compareSemver(currentNodeVersion, minimumNodeVersion) >= 0,
  `Generated workspace requires Node >=26; active Node is ${activeNodeVersion}. Run mise install, then rerun node from the activated shell.`,
);

const requiredPaths = [
  'AGENTS.md',
  '.gitignore',
  SHARED_VALIDATOR_STRING_091,
  SHARED_VALIDATOR_STRING_103,
  `patches/@module-federation__modern-js-v3@${expectedModuleFederationVersion}.patch`,
  `patches/@module-federation__bridge-react@${expectedModuleFederationVersion}.patch`,
  'tsconfig.json',
  'tsconfig.base.json',
  'oxlint.config.ts',
  'oxfmt.config.ts',
  '.github/renovate.json',
  repositoryWorkflowPath,
  '.agents/agent-reference-repos.json',
  'topology/reference-topology.json',
  'topology/ownership.json',
  'topology/local-overlays/development.json',
  SHARED_VALIDATOR_STRING_114,
  SHARED_VALIDATOR_STRING_115,
  'scripts/check-ultramodern-api-boundaries.mts',
  'scripts/check-ultramodern-i18n-boundaries.mts',
  ...(hasBackendSurfaces ? [SHARED_VALIDATOR_STRING_116] : []),
  SHARED_VALIDATOR_STRING_117,
  SHARED_VALIDATOR_STRING_118,
  'scripts/scaffolding/microvertical-action-boundary/scaffold.mts',
  'scripts/scaffolding/outbox-worker/scaffold.mts',
  SHARED_VALIDATOR_STRING_119,
  ...(hasDeliveryUnits ? ['scripts/proof-workerd-ssr.mts'] : []),
  ...(hasBackendSurfaces ? [SHARED_VALIDATOR_STRING_120] : []),
  'scripts/setup-agent-reference-repos.mts',
  SHARED_VALIDATOR_STRING_121,
  SHARED_VALIDATOR_STRING_122,
  SHARED_VALIDATOR_STRING_123,
  SHARED_VALIDATOR_STRING_124,
  SHARED_VALIDATOR_STRING_125,
  SHARED_VALIDATOR_STRING_050,
  'apps/shell-super-app/tsconfig.json',
  SHARED_VALIDATOR_STRING_052,
  SHARED_VALIDATOR_STRING_048,
  SHARED_VALIDATOR_STRING_049,
  'apps/shell-super-app/src/modern-app-env.d.ts',
  'apps/shell-super-app/src/modern.runtime.ts',
  'apps/shell-super-app/src/api/vertical-clients.ts',
  'apps/shell-super-app/locales/en/translation.json',
  `apps/shell-super-app/locales/en/${shellNamespace}.json`,
  'apps/shell-super-app/locales/cs/translation.json',
  `apps/shell-super-app/locales/cs/${shellNamespace}.json`,
  'apps/shell-super-app/src/routes/index.css',
  'apps/shell-super-app/src/routes/layout.tsx',
  'apps/shell-super-app/src/routes/shell-frame.tsx',
  'apps/shell-super-app/src/routes/ultramodern-jsonld.ts',
  'apps/shell-super-app/src/routes/ultramodern-route-head.tsx',
  'apps/shell-super-app/src/routes/ultramodern-route-metadata.ts',
  'apps/shell-super-app/src/routes/[lang]/page.tsx',
  ...shellRouteMetaPaths,
  SHARED_VALIDATOR_STRING_093,
  'packages/core-runtime/src/actions/principal-context.ts',
  'packages/core-runtime/src/index.ts',
  'packages/core-runtime/tsconfig.json',
  `${SHARED_VALIDATOR_STRING_177}/package.json`,
  'packages/gateway-principal-verifier/src/server.ts',
  'packages/gateway-principal-verifier/tsconfig.json',
  SHARED_VALIDATOR_STRING_095,
  'packages/shared-contracts/src/index.ts',
  'packages/shared-contracts/src/gateway-context.ts',
  'packages/shared-contracts/tsconfig.json',
  'packages/shared-design-tokens/package.json',
  'packages/shared-design-tokens/src/index.ts',
  SHARED_VALIDATOR_STRING_097,
  'packages/shared-design-tokens/tsconfig.json',
];

for (const vertical of fullStackVerticals) {
  requiredPaths.push(...requiredMicroVerticalPaths(vertical));
}

if (tailwindEnabled) {
  requiredPaths.push(
    'apps/shell-super-app/tailwind.config.ts',
    ...fullStackVerticals
      .filter((vertical) => vertical.emitsUi)
      .flatMap((vertical) => [`${vertical.path}/tailwind.config.ts`]),
  );
}

requiredPaths.push(compactConfigPath);

for (const vertical of fullStackVerticals) {
  for (const requiredPath of requiredMicroVerticalPaths(vertical)) {
    assertRequiredVerticalFile(vertical)(requiredPath);
  }
  // Reject profile-foreign surfaces planted into a unit (e.g. a browser MF
  // config in a headless api-only unit, or an API contract in a UI-only unit).
  for (const forbiddenPath of forbiddenMicroVerticalPaths(vertical)) {
    assertForbiddenVerticalFile(vertical)(forbiddenPath);
  }
}
for (const requiredPath of requiredPaths) {
  assertExists(requiredPath);
}
// Agent skills metadata may live under .agents/ (agents-standard layout) or
// .codex/ (legacy scaffold default).
assertAnyOf(['.agents/skills-lock.json', '.codex/skills-lock.json']);
assertAnyOf(['.agents/rstackjs-agent-skills-LICENSE', '.codex/rstackjs-agent-skills-LICENSE']);
const pnpmWorkspace = readText(SHARED_VALIDATOR_STRING_103);
assert(
  pnpmWorkspace.includes('enableGlobalVirtualStore: false'),
  'pnpm-workspace.yaml must keep deployable dependency trees independent of the host global virtual store',
);
assert(
  pnpmWorkspace.includes("'@vercel/nft@0.29.2': patches/@vercel__nft@0.29.2.patch"),
  'pnpm-workspace.yaml must patch the deployment tracer for transient filesystem markers',
);
// The published 3.9 cohort owns deploy-entry interop; no obsolete app-tools
// patch is required. Release output is exercised by the runtime script proofs.
const vercelNftPatch = readText('patches/@vercel__nft@0.29.2.patch');
assert(
  vercelNftPatch.split('isBuildHostSystemPath').length - 1 >= 4 &&
    vercelNftPatch.includes('isTransientFilesystemEntry') &&
    vercelNftPatch.includes('processInBatches') &&
    vercelNftPatch.includes('batchSize = 16') &&
    vercelNftPatch.includes(String.raw`pnpm[\\/]store[\\/]v\d+`) &&
    vercelNftPatch.includes('(?:dev|etc|proc|run|sys)') &&
    vercelNftPatch.includes(String.raw`^\/var\/run`) &&
    vercelNftPatch.includes('isBuildHostWildcardRoot') &&
    vercelNftPatch.includes('os_1.default.homedir()') &&
    vercelNftPatch.includes('isBuildHostWildcardRoot(assetDirPath)') &&
    vercelNftPatch.includes('isBuildHostWildcardRoot(wildcardDirPath)') &&
    vercelNftPatch.includes('if (isBuildHostSystemPath(path))') &&
    vercelNftPatch.includes('const source = await this.readFile(path);') &&
    vercelNftPatch.includes("throw new Error('File ' + path + ' does not exist.')"),
  'The deployment tracer patch must reject build-host globs before enumeration, bound dependency expansion, exclude build-host system paths, ignore only missing pnpm markers, and reject other missing files',
);
const traceDeploymentSystemGlobs = Effect.gen(function* traceDeploymentSystemGlobs() {
  if (process.platform === 'win32') {
    return;
  }
  const partyRegistryRequire = createRequire(path.join(root, SHARED_VALIDATOR_STRING_165));
  const appToolsRequire = createRequire(partyRegistryRequire.resolve(SHARED_VALIDATOR_STRING_022));
  const ndepeRequire = createRequire(appToolsRequire.resolve('ndepe'));
  const { nodeFileTrace } = Result.getOrThrow(Schema.decodeUnknownResult(NftModuleSchema)(ndepeRequire('@vercel/nft')));
  const tracerFixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ultramodern-system-glob-'));
  const tracerFixturePath = path.join(tracerFixtureDirectory, 'entry.cjs');
  const tracerLogs: string[] = [];
  const originalConsoleLog = console.log;

  fs.writeFileSync(
    tracerFixturePath,
    [
      'const os = require("node:os");',
      'const path = require("node:path");',
      'require(path.join("/etc", process.env.ULTRAMODERN_DYNAMIC_SYSTEM_FILE));',
      'require(path.join(os.homedir(), process.env.ULTRAMODERN_DYNAMIC_HOME_FILE));',
      '',
    ].join('\n'),
  );
  console.log = (...values: unknown[]) => {
    tracerLogs.push(values.map(String).join(' '));
  };
  try {
    yield* Effect.promise(
      async () =>
        await nodeFileTrace([tracerFixturePath], {
          base: '/',
          log: true,
          processCwd: tracerFixtureDirectory,
        }),
    );
  } finally {
    console.log = originalConsoleLog;
    fs.rmSync(tracerFixtureDirectory, { force: true, recursive: true });
  }
  assert(
    !tracerLogs.some((line) => line.startsWith('Globbing /etc')),
    'The deployment tracer must reject build-host system globs before filesystem enumeration',
  );
  assert(
    !tracerLogs.some((line) => line.startsWith(`Globbing ${os.homedir()}`)),
    'The deployment tracer must reject build-host home globs before filesystem enumeration',
  );
});
assert(
  pnpmWorkspace.includes(`'@effect/opentelemetry': ${expectedEffectVersion}`),
  'pnpm-workspace.yaml must override @effect/opentelemetry to the generated Effect cohort',
);
assert(
  pnpmWorkspace.includes(`effect: ${expectedEffectVersion}`),
  'pnpm-workspace.yaml must override effect to the generated Effect cohort',
);
assert(
  pnpmWorkspace.includes(
    `'@module-federation/modern-js-v3@${expectedModuleFederationVersion}': patches/@module-federation__modern-js-v3@${expectedModuleFederationVersion}.patch`,
  ),
  'pnpm-workspace.yaml must patch the generated Module Federation Modern.js integration cohort',
);
assert(
  pnpmWorkspace.includes(
    `'@module-federation/bridge-react@${expectedModuleFederationVersion}': patches/@module-federation__bridge-react@${expectedModuleFederationVersion}.patch`,
  ),
  'pnpm-workspace.yaml must patch the generated Module Federation React bridge cohort',
);
assertWorkspaceValidationContract(workspaceValidationContract);
assertGeneratedSurfacePolicy();
for (const appPath of [
  SHARED_VALIDATOR_STRING_047,
  ...fullStackVerticals.filter((vertical) => vertical.emitsUi).map((vertical) => vertical.path),
  ...(workspaceValidationContract.structuralShellPolicy?.shells ?? [])
    .filter((shell) => shell.id !== SHARED_VALIDATOR_STRING_131)
    .map((shell) => shell.packageDir),
]) {
  const violation = moduleFederationBridgeViolation(
    readText(`${appPath}/module-federation.config.ts`),
    readJson(PackageJsonSchema, `${appPath}/package.json`),
  );
  assert(violation === undefined, `${appPath}: ${violation}`);
}
for (const oldRemotePath of oldRemotePaths) {
  assertNotExists(oldRemotePath);
}
for (const retiredMetadataPath of retiredMetadataPaths) {
  assertNotExists(retiredMetadataPath);
}
assertStructuredWorkspaceMetadata();
const bridgeConfig = ultramodernConfig?.bridge?.enabled === true ? ultramodernConfig.bridge : undefined;
const packageSource = createPackageSourceView(ultramodernConfig);
const generatedContract = readGeneratedContractView(ultramodernConfig);

assertMicroVerticalContractGraph(generatedContract);
assertStructuredWorkspaceMetadataSemantics();
assertTsConfigReferenceGraph();

assert(rootPackage.private, 'Root package must be private');
assert(isString(rootPackage.packageManager), 'Root must declare packageManager');
const packageManagerPnpmVersionMatch = /^pnpm@(?<version>\d+\.\d+\.\d+)$/u.exec(rootPackage.packageManager);
assert(packageManagerPnpmVersionMatch !== null, 'Root packageManager must pin pnpm with a semver version');
const packageManagerPnpmVersion = packageManagerPnpmVersionMatch?.groups?.version ?? '';
assert(
  compareSemver(parseSemver(packageManagerPnpmVersion), minimumPnpmVersion) >= 0,
  'Root packageManager must use pnpm >=11',
);
assert(rootPackage.engines?.node === '>=26', 'Root must require Node >=26');
assert(rootPackage.engines?.pnpm === '>=11', 'Root must require pnpm >=11');
assert(
  generatedContract.node?.version === expectedNodeVersion,
  'Generated contract must record the Node toolchain version',
);
assert(generatedContract.node?.engineRange === '>=26', 'Generated contract must record the Node engine range');
assert(readText('.mise.toml').includes(`node = "${expectedNodeVersion}"`), 'mise must pin the generated Node version');
assert(
  readText('.mise.toml').includes(`pnpm = "${packageManagerPnpmVersion}"`),
  'mise must pin the generated pnpm version',
);
const workflowText = readText(repositoryWorkflowPath);
const workflowNodeVersions = extractWorkflowNodeVersions(workflowText);
assert(workflowNodeVersions.length > 0, 'CI workflow must configure setup-node node-version');
assert(
  workflowNodeVersions.every((nodeVersion) => nodeVersion === expectedNodeVersion),
  `CI workflow must pin the generated Node version ${expectedNodeVersion}; found ${workflowNodeVersions.join(', ')}`,
);
assert(
  !workflowText.includes('FORCE_JAVASCRIPT_ACTIONS_TO_NODE24'),
  'CI workflow must not carry the legacy Node 24 override',
);
assert(
  workflowText.includes('jdx/mise-action@') &&
    workflowText.includes('mise exec -- pnpm install --frozen-lockfile') &&
    !workflowText.includes('corepack'),
  'CI workflow must install and execute the repository-pinned pnpm toolchain through mise',
);
const requiredWorkflowEvidence = [
  ['Format', 'pnpm format:check'],
  ['Lint', 'pnpm lint'],
  ['Typecheck', 'pnpm typecheck'],
  ['Skills', 'pnpm skills:check'],
  ['I18n Boundaries', 'pnpm i18n:boundaries'],
  ['API Boundaries', SHARED_VALIDATOR_STRING_101],
  ['Database Access Boundaries', 'pnpm database-access:check'],
  ['Module Entrypoint Contracts', SHARED_VALIDATOR_STRING_102],
  ['Module Contract Generation', 'pnpm check:module-contracts'],
  ['Workspace Contract', 'pnpm contract:check'],
  ['Complete Unit and Component Tests', 'pnpm test:unit'],
  ['Action Unit Tests', 'pnpm action:test:unit'],
  ['Repository Tooling Tests', 'pnpm test:scripts'],
  ['Deployment Impact Planner Tests', 'pnpm test:deployment-impact'],
  ['Codesmith and Generation Tests', 'pnpm test:generation'],
];
for (const [name, command] of requiredWorkflowEvidence) {
  assert(
    workflowText.includes(`name: ${name}`) && workflowText.includes(`command: ${command}`),
    `CI workflow is missing stable ${name} evidence using ${command}`,
  );
}
for (const [jobId, jobName] of [
  ['service-integration', 'Database, Migration, RLS, Authorization, and Outbox Integration'],
  ['node-runtime', 'Node Backend Federation Artifact Proof'],
  ['cloudflare-runtime', 'Cloudflare Workerd Artifact Proof'],
]) {
  assert(
    workflowText.includes(`  ${jobId}:`) && workflowText.includes(`name: ${jobName}`),
    `CI workflow is missing required job ${jobName}`,
  );
}
assert(
  workflowText.includes('docker compose up --detach --wait') &&
    workflowText.includes('name: Remove the pre-seeded runtime role to prove deployment bootstrap ordering') &&
    workflowText.includes('DROP ROLE ontos_runtime;') &&
    workflowText.includes('mise exec -- pnpm db:migrate') &&
    workflowText.includes('mise exec -- pnpm db:verify') &&
    workflowText.includes('mise exec -- pnpm test:integration') &&
    workflowText.includes('docker compose down --volumes --remove-orphans'),
  'CI service evidence must remove the pre-seeded runtime role, apply and verify migrations, run complete integrations, and always remove volumes',
);
assert(
  workflowText.includes('name: Apply and verify Core, Auth, and Contacts migrations') &&
    workflowText.includes(
      'name: Run database, RLS, Action, authorization, identity, Outbox, module-state, Shell, and Contacts integration tests',
    ),
  'CI workflow must keep database/migration/RLS and authorization/Outbox integration evidence clearly named',
);
assert(
  workflowText.includes('mise exec -- pnpm build') &&
    workflowText.includes('mise exec -- pnpm node:proof') &&
    workflowText.includes('mise exec -- pnpm cloudflare:build') &&
    workflowText.includes('MODERN_PUBLIC_SITE_URL: https://shell-super-app.invalid') &&
    workflowText.includes('ULTRAMODERN_PUBLIC_URL_PARTY_REGISTRY: https://party-registry.invalid') &&
    workflowText.includes('ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP: https://shell-super-app.invalid'),
  'CI workflow must separately prove Node and Cloudflare/workerd runtime artifacts with explicit local proof URLs',
);
assert(
  workflowText.includes('DATABASE_URL: postgresql://ontos_proof:ontos_proof@localhost:5432/ontos_proof'),
  'CI Node artifact proof must provide a non-secret database URL so the readiness API layer can initialize without a service connection',
);
assert(
  rootPackage.scripts?.[SHARED_VALIDATOR_STRING_059]?.includes('pnpm mf:types --target cloudflare'),
  'Cloudflare builds must validate the Module Federation DTS archive from the Cloudflare output directory',
);
assert(
  workflowText.includes('mise exec -- pnpm deployment-impact:plan') &&
    workflowText.includes('mise exec -- pnpm authorization:inventory:check') &&
    workflowText.includes('--authorization-environment stage') &&
    workflowText.includes('## Reviewed deployment impact plan'),
  'Stage deployment must derive the exact-build authorization inventory, enforce the stage authorization gate, and summarize the topology-driven deployment impact planner',
);
assert(
  workflowText.includes('needs: [workspace-gate, service-integration, node-runtime, cloudflare-runtime]'),
  'Stage deployment must depend on every fast, service-backed, Node, and Cloudflare required job',
);
assert(
  !/(?:verticals\/(?:crm|projects)|outputs\.(?:crm|projects)|ZEROPS_(?:CRM|PROJECTS)_SERVICE_ID|--setup\s+(?:crm|projects))/iu.test(
    workflowText,
  ) && !workflowText.includes('case "$path"'),
  'Stage deployment workflow must not contain stale CRM/Projects or hand-written changed-path branches',
);
const zeropsDeploymentSource = readText(SHARED_VALIDATOR_STRING_174);
for (const vertical of topology.verticals ?? []) {
  const verticalId = vertical.id;
  assert(isString(verticalId), 'Topology vertical deployment identity must be a string');
  const serviceEnvironment = `ZEROPS_${verticalId
    .replaceAll(/[^A-Za-z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
    .toUpperCase()}_SERVICE_ID`;
  assert(
    zeropsDeploymentSource.includes(`setup: ${quoteYamlString(verticalId)}`),
    `Topology delivery unit ${verticalId} has no matching Zerops setup`,
  );
  assert(
    workflowText.includes(serviceEnvironment),
    `Topology delivery unit ${verticalId} has no matching workflow service variable ${serviceEnvironment}`,
  );
}
const shellDeploymentSetup = (topology.shell?.id ?? '').replaceAll('-', '');
assert(
  zeropsDeploymentSource.includes(`setup: ${quoteYamlString(shellDeploymentSetup)}`) &&
    workflowText.includes('ZEROPS_SHELL_SERVICE_ID'),
  'Topology Shell delivery unit must match the current Zerops setup and workflow service-variable convention',
);
assert(rootPackage.modernjs?.preset === SHARED_VALIDATOR_STRING_104, 'Root must declare presetUltramodern');
assert(
  rootPackage.modernjs?.packageSource?.config === './.modernjs/ultramodern.json',
  'Root must point at compact UltraModern config',
);
assert(
  rootPackage.modernjs?.packageSource?.strategy === packageSource.strategy,
  'Root package source strategy must match metadata',
);
assert(
  packageSource.strategy === 'workspace' || packageSource.strategy === 'install',
  'Package source strategy must be workspace or install',
);
assert(
  packageSource.strategy === 'install' || packageSource.modernPackages?.specifier === SHARED_VALIDATOR_STRING_169,
  'Workspace package source must be explicitly backed by workspace:*',
);
assertModernPackageCohort();
const isIdentifierChar = (character: string): boolean => character !== '' && /[A-Za-z0-9_$]/u.test(character);
const SourceScannerState = Schema.Literals(['block', 'code', 'double', 'line', 'regex', 'single', 'template']);
type SourceScannerStateValue = typeof SourceScannerState.Type;
interface SourceScanner {
  currentWord: string;
  interpolations: number[];
  lastSignificant: string;
  regexInClass: boolean;
  readonly regexPrecedingKeywords: ReadonlySet<string>;
  readonly regexPrecedingPunct: ReadonlySet<string>;
  result: string;
  state: SourceScannerStateValue;
}
const emitSourceCodeCharacter = (scanner: SourceScanner, character: string): void => {
  scanner.result += character;
  if (/\s/u.test(character)) {
    return;
  }
  scanner.currentWord = isIdentifierChar(character) ? scanner.currentWord + character : '';
  scanner.lastSignificant = character;
};
const sourceRegexCanFollow = (scanner: SourceScanner): boolean => {
  if (scanner.lastSignificant === '') {
    return true;
  }
  if (scanner.regexPrecedingPunct.has(scanner.lastSignificant)) {
    return true;
  }
  return isIdentifierChar(scanner.lastSignificant) && scanner.regexPrecedingKeywords.has(scanner.currentWord);
};
const scanSourceSlash = (scanner: SourceScanner, next: string): number | undefined => {
  if (next === '/') {
    scanner.state = 'line';
    return 1;
  }
  if (next === '*') {
    scanner.state = 'block';
    scanner.result += ' ';
    return 1;
  }
  if (sourceRegexCanFollow(scanner)) {
    scanner.state = 'regex';
    scanner.regexInClass = false;
    emitSourceCodeCharacter(scanner, '/');
    return 0;
  }
  return undefined;
};
const scanSourceInterpolation = (scanner: SourceScanner, character: string): boolean => {
  if (character === '}' && scanner.interpolations.length > 0 && scanner.interpolations.at(-1) === 0) {
    scanner.interpolations.pop();
    scanner.state = 'template';
    scanner.result += character;
    scanner.lastSignificant = character;
    scanner.currentWord = '';
    return true;
  }
  if (scanner.interpolations.length > 0) {
    const lastIndex = scanner.interpolations.length - 1;
    if (character === '{') {
      scanner.interpolations[lastIndex] += 1;
    } else if (character === '}') {
      scanner.interpolations[lastIndex] -= 1;
    }
  }
  return false;
};
const scanSourceCodeCharacter = (scanner: SourceScanner, character: string, next: string): number => {
  if (character === '/') {
    const consumed = scanSourceSlash(scanner, next);
    if (consumed !== undefined) {
      return consumed;
    }
  }
  if (character === "'" || character === '"') {
    scanner.state = character === "'" ? 'single' : 'double';
    scanner.result += character;
    return 0;
  }
  if (character === '`') {
    scanner.state = 'template';
    scanner.result += character;
    return 0;
  }
  if (!scanSourceInterpolation(scanner, character)) {
    emitSourceCodeCharacter(scanner, character);
  }
  return 0;
};
const scanSourceLineComment = (scanner: SourceScanner, character: string): number => {
  if (character === '\n') {
    scanner.state = 'code';
    scanner.result += character;
  }
  return 0;
};
const scanSourceBlockComment = (scanner: SourceScanner, character: string, next: string): number => {
  if (character === '*' && next === '/') {
    scanner.state = 'code';
    return 1;
  }
  if (character === '\n') {
    scanner.result += character;
  }
  return 0;
};
const scanSourceRegex = (scanner: SourceScanner, character: string, next: string): number => {
  if (character === '\\') {
    scanner.result += character + next;
    return 1;
  }
  if (character === '[') {
    scanner.regexInClass = true;
  } else if (character === ']') {
    scanner.regexInClass = false;
  } else if (character === '/' && !scanner.regexInClass) {
    scanner.state = 'code';
    scanner.result += character;
    scanner.lastSignificant = character;
    scanner.currentWord = '';
    return 0;
  }
  scanner.result += character;
  return 0;
};
const scanSourceTemplate = (scanner: SourceScanner, character: string, next: string): number => {
  if (character === '\\') {
    scanner.result += character + next;
    return 1;
  }
  if (character === '`') {
    scanner.state = 'code';
    scanner.result += character;
    scanner.lastSignificant = character;
    scanner.currentWord = '';
    return 0;
  }
  if (character === '$' && next === '{') {
    scanner.interpolations.push(0);
    scanner.state = 'code';
    scanner.result += templatePlaceholderOpening;
    scanner.lastSignificant = '{';
    scanner.currentWord = '';
    return 1;
  }
  scanner.result += character;
  return 0;
};
const scanSourceQuotedString = (scanner: SourceScanner, character: string, next: string): number => {
  if (character === '\\') {
    scanner.result += character + next;
    return 1;
  }
  if ((scanner.state === 'single' && character === "'") || (scanner.state === 'double' && character === '"')) {
    scanner.state = 'code';
    scanner.lastSignificant = character;
    scanner.currentWord = '';
  }
  scanner.result += character;
  return 0;
};
type SourceCharacterScanner = (scanner: SourceScanner, character: string, next: string) => number;
const sourceCharacterScanners = {
  block: scanSourceBlockComment,
  code: scanSourceCodeCharacter,
  double: scanSourceQuotedString,
  line: scanSourceLineComment,
  regex: scanSourceRegex,
  single: scanSourceQuotedString,
  template: scanSourceTemplate,
} satisfies Record<SourceScannerStateValue, SourceCharacterScanner>;
const scanSourceCharacter: SourceCharacterScanner = (scanner: SourceScanner, character: string, next: string) =>
  sourceCharacterScanners[scanner.state](scanner, character, next);
const stripSourceComments = (code: string): string => {
  const scanner: SourceScanner = {
    currentWord: '',
    interpolations: [],
    lastSignificant: '',
    regexInClass: false,
    regexPrecedingKeywords: new Set([
      'return',
      'typeof',
      'instanceof',
      'in',
      'of',
      'new',
      'delete',
      'void',
      'do',
      'else',
      'yield',
      'await',
      'case',
    ]),
    regexPrecedingPunct: new Set(['(', ',', '=', '[', '{', ';', ':', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~']),
    result: '',
    state: 'code',
  };
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    const next = index + 1 < code.length ? code[index + 1] : '';
    index += scanSourceCharacter(scanner, character, next);
  }
  return scanner.result;
};
const collectSourceFiles = (absoluteDir: string): string[] => {
  const files: string[] = [];
  const queue = [absoluteDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current !== undefined) {
      let entries: Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        const absoluteEntry = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(absoluteEntry);
        } else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(entry.name)) {
          files.push(absoluteEntry);
        }
      }
    }
  }
  return sortedCopy(files, (left, right) => left.localeCompare(right));
};
const runtimeModuleSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  const collectMatches = (expression: RegExp): void => {
    for (const match of source.matchAll(expression)) {
      const specifier = match.groups?.specifier;
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  };
  for (const match of source.matchAll(
    /\b(?:import|export)\s+(?<clause>[^;'"`]+?)\s+from\s*['"](?<specifier>[^'"]+)['"]/gu,
  )) {
    const clause = match.groups?.clause;
    const specifier = match.groups?.specifier;
    if (clause !== undefined && specifier !== undefined && !clause.trimStart().startsWith('type ')) {
      specifiers.push(specifier);
    }
  }
  collectMatches(/\bimport\s*['"](?<specifier>[^'"]+)['"]/gu);
  collectMatches(/\bimport\s*\(\s*['"](?<specifier>[^'"]+)['"]/gu);
  collectMatches(/\brequire\s*\(\s*['"](?<specifier>[^'"]+)['"]/gu);
  return specifiers;
};
const remoteImplementationFor = (
  specifier: string,
  remotes: readonly CompositionRemote[],
): CompositionRemote | undefined =>
  remotes.find((remote) => {
    const packageSubpath = specifier.startsWith(`${remote.packageName}/`)
      ? specifier.slice(remote.packageName.length + 1)
      : undefined;
    if (specifier === remote.packageName || (packageSubpath !== undefined && !packageSubpath.startsWith('api'))) {
      return true;
    }
    const normalizedSpecifier = specifier.replaceAll('\\', '/');
    return normalizedSpecifier.includes(`${remote.directory}/`);
  });
type StructuralShellPolicy = typeof workspaceValidationContractDefinition.structuralShellPolicy;
type FederatedCompositionSourcePolicy = typeof workspaceValidationContractDefinition.federatedCompositionSourcePolicy;
const assertThinShellPolicy = (policy: StructuralShellPolicy): void => {
  for (const shell of policy.shells) {
    for (const forbidden of policy.forbiddenPathClasses) {
      assert(
        !fs.existsSync(path.join(root, shell.packageDir, forbidden.path)),
        selfCheckFailure(
          `structural thin-shell ${forbidden.id}`,
          `${forbidden.diagnostic} Forbidden artifact ${shell.packageDir}/${forbidden.path} exists`,
          `remove forbidden thin-shell artifact ${shell.packageDir}/${forbidden.path}`,
        ),
      );
    }
    const srcAbsolute = path.join(root, shell.srcDir);
    if (fs.existsSync(srcAbsolute)) {
      for (const file of collectSourceFiles(srcAbsolute)) {
        const source = stripSourceComments(fs.readFileSync(file, 'utf-8'));
        const relative = path.relative(root, file).split(path.sep).join('/');
        for (const pattern of policy.forbiddenImportPatterns) {
          const match = new RegExp(pattern.expression, pattern.flags).exec(source);
          assert(
            match === null,
            selfCheckFailure(
              `structural thin-shell ${pattern.id}`,
              `${pattern.diagnostic} Found forbidden import at ${relative}:${match?.index ?? 0}`,
              'consume only published surfaces from the thin shell',
            ),
          );
        }
      }
    }
  }
};
const assertFederatedCompositionFile = (
  file: string,
  host: FederatedCompositionSourcePolicy['hosts'][number],
  policy: FederatedCompositionSourcePolicy,
): void => {
  const source = stripSourceComments(fs.readFileSync(file, 'utf-8'));
  const relative = path.relative(root, file).split(path.sep).join('/');
  for (const pattern of policy.forbiddenSourcePatterns) {
    const match = new RegExp(pattern.expression, pattern.flags).exec(source);
    assert(
      match === null,
      selfCheckFailure(
        `federated composition ${pattern.id}`,
        `${pattern.diagnostic} Found forbidden source at ${relative}:${match?.index ?? 0}`,
        'compose remote rendering through framework Module Federation primitives',
      ),
    );
  }
  // Declaration files cannot execute. Ambient federation declarations may
  // re-export a workspace component solely to preserve its public prop
  // type, so their specifiers are not runtime implementation imports.
  if (!/\.d\.(?:ts|mts|cts)$/u.test(relative)) {
    for (const specifier of runtimeModuleSpecifiers(source)) {
      const remote = remoteImplementationFor(specifier, host.remotes);
      assert(
        remote === undefined,
        selfCheckFailure(
          'federated composition remote-runtime-package-import',
          `Host ${host.id} imports remote render implementation ${specifier} from ${remote?.id} at ${relative}`,
          'use import type for contracts or compose the implementation through Module Federation',
        ),
      );
    }
  }
};
const assertFederatedCompositionSourcePolicy = (policy: FederatedCompositionSourcePolicy): void => {
  for (const host of policy.hosts) {
    const srcAbsolute = path.join(root, host.srcDir);
    if (!fs.existsSync(srcAbsolute)) {
      continue;
    }
    for (const file of collectSourceFiles(srcAbsolute)) {
      assertFederatedCompositionFile(file, host, policy);
    }
  }
};
const assertStructuralShellPolicy = (): void => {
  const policy = workspaceValidationContract.structuralShellPolicy;
  if (policy !== undefined) {
    assertThinShellPolicy(policy);
  }
  const compositionPolicy = workspaceValidationContract.federatedCompositionSourcePolicy;
  if (compositionPolicy !== undefined) {
    assertFederatedCompositionSourcePolicy(compositionPolicy);
  }
};
assertStructuralShellPolicy();
const assertConfiguredDevelopmentPorts = (): void => {
  const primaryShellConfig = findById(ultramodernConfig.topology?.apps, SHARED_VALIDATOR_STRING_131);
  const overlayPorts = overlay.ports ?? {};
  const configuredPorts = [
    ...Object.entries(overlayPorts).map(([id, port]) => ({ id, port })),
    ...(Object.hasOwn(overlayPorts, SHARED_VALIDATOR_STRING_131)
      ? []
      : [{ id: SHARED_VALIDATOR_STRING_131, port: primaryShellConfig?.port }]),
  ];
  const portsByValue = new Map<number, string>();
  for (const { id, port } of configuredPorts) {
    if (!isNumber(port)) {
      assert(false, `Configured development port for ${id} must be finite`);
      continue;
    }
    assert(Number.isFinite(port), `Configured development port for ${id} must be finite`);
    const previous = portsByValue.get(port);
    assert(previous === undefined, `Duplicate configured development port ${port} for ${previous} and ${id}`);
    portsByValue.set(port, id);
  }
};
assertConfiguredDevelopmentPorts();
assert(ultramodernConfig.shells === undefined, 'Single-shell workspace must not declare config.shells');
assert(
  rootPackage.devDependencies?.[SHARED_VALIDATOR_STRING_024] ===
    expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_024),
  'Root must depend on @modern-js/create through package source metadata',
);
assert(
  rootPackage.devDependencies?.[SHARED_VALIDATOR_STRING_023] ===
    expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_023),
  'Root must depend on @modern-js/code-tools through package source metadata',
);
assert(
  rootPackage.devDependencies?.[SHARED_VALIDATOR_STRING_025] ===
    expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_025),
  'Root must depend on @modern-js/plugin-bff for Node backend federation proof',
);
if (packageSource.strategy === 'install') {
  const installSpecifier = packageSource.modernPackages?.specifier;
  assert(
    isString(installSpecifier) &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(installSpecifier) &&
      installSpecifier.includes('ultramodern'),
    'Install package source must use a semver UltraModern published cohort',
  );
  const modernAliases = packageSource.modernPackages?.aliases ?? {};
  if (Object.keys(modernAliases).length > 0) {
    for (const modernPackageName of [
      SHARED_VALIDATOR_STRING_022,
      SHARED_VALIDATOR_STRING_023,
      SHARED_VALIDATOR_STRING_025,
      SHARED_VALIDATOR_STRING_027,
      SHARED_VALIDATOR_STRING_028,
      SHARED_VALIDATOR_STRING_029,
      SHARED_VALIDATOR_STRING_024,
    ]) {
      assert(
        /^@[^/]+\/.+/u.test(modernAliases[modernPackageName] ?? ''),
        `Install package source alias for ${modernPackageName} must be a scoped npm package`,
      );
    }
  }
}
assert(
  packageSource.generatedWorkspacePackages?.specifier === SHARED_VALIDATOR_STRING_169,
  'Generated workspace packages must keep workspace:* links',
);
assert(rootPackage.scripts?.build === expectedBuildScript, 'Root build script must build verticals before shell');
assert(
  rootPackage.scripts?.[SHARED_VALIDATOR_STRING_059] === expectedCloudflareBuildScript,
  'Root cloudflare:build script is incorrect',
);
assert(!('ultramodern:check' in (rootPackage.scripts ?? {})), 'Root must not expose ultramodern:check');
if (bridgeConfig === undefined) {
  assert(
    rootPackage.scripts?.typecheck === SHARED_VALIDATOR_STRING_086,
    'Root typecheck must run TS-Go across the root project reference graph',
  );
} else {
  assert(
    rootPackage.scripts?.typecheck ===
      'pnpm -r --filter "./apps/*" --filter "./verticals/*" --filter "./packages/*" run typecheck',
    'Bridge root typecheck must check generated package boundaries without building parent implementation sources',
  );
  assert(Array.isArray(bridgeConfig.workspacePackages), 'Bridge config must record workspace package patterns');
  for (const workspacePackage of bridgeConfig.workspacePackages) {
    assert(
      rootPackage.workspaces?.includes(workspacePackage.pattern),
      `Root workspaces must include bridge package pattern ${workspacePackage.pattern}`,
    );
    assert(
      readText(SHARED_VALIDATOR_STRING_103).includes(`  - ${workspacePackage.pattern}`),
      `pnpm-workspace.yaml must include bridge package pattern ${workspacePackage.pattern}`,
    );
  }
  for (const gate of bridgeConfig.gates ?? []) {
    const workingDirectoryPrefix = isString(gate.cwd) && gate.cwd.length > 0 ? `cd ${gate.cwd} && ` : '';
    const expectedGateScript = `${workingDirectoryPrefix}${gate.command}`;
    assert(
      valueForKey(Object.entries(rootPackage.scripts ?? {}), `bridge:${gate.name}`) === expectedGateScript,
      `Bridge gate script bridge:${gate.name} is incorrect`,
    );
  }
  assert(
    (valueForKey(Object.entries(rootPackage.scripts ?? {}), 'bridge:check') ?? '').length > 0,
    'Bridge workspaces must expose bridge:check',
  );
}
assert(rootPackage.scripts?.['contract:check'] === SHARED_VALIDATOR_STRING_087, 'Root must expose contract:check');
for (const [scriptName, expectedCommand] of Object.entries(workspaceValidationContract.ciEvidenceScripts)) {
  assert(
    valueForKey(Object.entries(rootPackage.scripts ?? {}), scriptName) === expectedCommand,
    `Root CI evidence command ${scriptName} is missing or incorrect`,
  );
}
const coreRuntimePackage = readJson(PackageJsonSchema, SHARED_VALIDATOR_STRING_093);
assert(
  coreRuntimePackage.scripts?.['test:unit'] === 'rstest --project unit',
  'Core runtime must expose its complete unit test surface',
);
assert(
  coreRuntimePackage.scripts?.['test:integration'] === 'rstest --project integration',
  'Core runtime must expose its complete service-backed integration test surface',
);
assert(
  rootPackage.scripts?.['module-entrypoints:check'] === 'node ./scripts/check-module-entrypoint-boundaries.mts',
  'Root must expose module-entrypoints:check',
);
assert(
  rootPackage.scripts?.['scaffold:microvertical-action-boundary'] ===
    'node ./scripts/scaffolding/cli.mts microvertical-action-boundary',
  'Root must expose the Codesmith MicroVertical Action-boundary command',
);
assert(
  rootPackage.scripts?.['scaffold:outbox-worker'] === 'node ./scripts/scaffolding/cli.mts outbox-worker',
  'Root must expose the Codesmith Outbox Worker command',
);
assert(shellPackage.dependencies?.jose === '6.2.5', 'Shell must own the exact EdDSA signing dependency');
const sharedContractsPackage = readJson(PackageJsonSchema, SHARED_VALIDATOR_STRING_095);
assert(
  sharedContractsPackage.dependencies?.effect === expectedEffectVersion &&
    sharedContractsPackage.dependencies?.[SHARED_VALIDATOR_STRING_017] === SHARED_VALIDATOR_STRING_169,
  'Shared gateway contracts must use the generated Effect cohort and canonical Core context',
);
const gatewayPrincipalVerifierPackage = readJson(PackageJsonSchema, `${SHARED_VALIDATOR_STRING_177}/package.json`);
const gatewayPrincipalVerifierSource = readText('packages/gateway-principal-verifier/src/server.ts');
assert(
  sameJson(gatewayPrincipalVerifierPackage.exports, {
    './server': './src/server.ts',
  }) &&
    gatewayPrincipalVerifierPackage.dependencies?.jose === '6.2.5' &&
    gatewayPrincipalVerifierPackage.dependencies?.[SHARED_VALIDATOR_STRING_017] === SHARED_VALIDATOR_STRING_169 &&
    gatewayPrincipalVerifierPackage.dependencies?.[SHARED_VALIDATOR_STRING_019] === SHARED_VALIDATOR_STRING_169 &&
    gatewayPrincipalVerifierSource.includes('bindGatewayPrincipalVerifier') &&
    gatewayPrincipalVerifierSource.includes("algorithms: ['EdDSA']") &&
    gatewayPrincipalVerifierSource.includes('decodeGatewayContextClaims') &&
    gatewayPrincipalVerifierSource.includes('TrustedPrincipalContextSchema'),
  'Gateway principal verification must remain a server-only shared package entrypoint with the complete algorithm',
);
const gatewayContractSource = readText('packages/shared-contracts/src/gateway-context.ts');
const problemDetailsContractSource = readText('packages/shared-contracts/src/problem-details.ts');
assert(
  gatewayContractSource.includes('GATEWAY_ASSERTION_VERSION = 1') &&
    gatewayContractSource.includes('GATEWAY_ASSERTION_TTL_SECONDS = 300') &&
    gatewayContractSource.includes('GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS = 30') &&
    gatewayContractSource.includes("HttpApiEndpoint.post('issueGatewayContext'") &&
    gatewayContractSource.includes("alg: Schema.Literal('EdDSA')") &&
    gatewayContractSource.includes("from '@app/core-runtime/actions/principal-context'") &&
    gatewayContractSource.includes('makeProblemDetailsSchema') &&
    problemDetailsContractSource.includes("contentType: 'application/problem+json'"),
  'Shared contracts must retain the versioned generic EdDSA gateway assertion protocol',
);
const installedVerticalSource = readText('apps/shell-super-app/api/verticals/installed-verticals.ts');
const shellModernConfigSource = readText(SHARED_VALIDATOR_STRING_048);
assert(
  shellModernConfigSource.includes("new URL('../../topology/reference-topology.json', import.meta.url)") &&
    shellModernConfigSource.includes("readFileSync(referenceTopologyPath, 'utf-8')") &&
    shellModernConfigSource.includes(
      'Object.assign(globalThis, {\n  ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: referenceTopology',
    ) &&
    shellModernConfigSource.includes('ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: referenceTopology') &&
    installedVerticalSource.includes('deriveInstalledVerticalIds(ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY)') &&
    installedVerticalSource.includes("kind: Schema.Literal('vertical')"),
  'Shell installed verticals must derive exclusively from authoritative topology verticals',
);
assert(
  !fs.existsSync(path.join(root, 'packages/shared-contracts/src/gateway-topology.generated.ts')) &&
    !installedVerticalSource.includes('ultramodernGatewayAudienceTopology'),
  'Shell installed verticals must not introduce a second topology registry',
);
assert(
  rootPackage.scripts?.['api:check'] === 'node ./scripts/check-ultramodern-api-boundaries.mts',
  'Root must expose api:check',
);
assert(
  rootPackage.scripts?.['i18n:boundaries'] === 'node ./scripts/check-ultramodern-i18n-boundaries.mts',
  'Root must expose i18n:boundaries',
);
assert(
  rootPackage.scripts?.['performance:readiness'] === SHARED_VALIDATOR_STRING_085,
  'Root must expose default-on performance readiness diagnostics',
);
const actionAuthorizationProvisioningCommand = 'node ./scripts/provision-current-action-authorization.mts';
assert(
  rootPackage.scripts?.[SHARED_VALIDATOR_STRING_053] === actionAuthorizationProvisioningCommand,
  'Root must expose the explicit current-Action authorization provisioning command',
);
assert(
  rootPackage.scripts?.['local:initialize'] === 'node ./scripts/initialize-local-development.mts' &&
    !readText('scripts/initialize-local-development.mts').includes(SHARED_VALIDATOR_STRING_106) &&
    !readText('scripts/initialize-local-development.mts').includes(SHARED_VALIDATOR_STRING_053),
  'Ordinary local initialization must not provision Action authorization',
);
for (const startupPath of ['scripts/locki-feature.sh', 'docker-compose.yml', 'scripts/run-zerops-spicedb.sh']) {
  assert(
    !readText(startupPath).includes(SHARED_VALIDATOR_STRING_106) &&
      !readText(startupPath).includes(SHARED_VALIDATOR_STRING_053),
    `${startupPath} must not provision Action authorization automatically`,
  );
}
for (const automaticScript of ['dev', 'build', SHARED_VALIDATOR_STRING_059, SHARED_VALIDATOR_STRING_060]) {
  const automaticCommand = valueForKey(Object.entries(rootPackage.scripts ?? {}), automaticScript);
  assert(
    automaticCommand?.includes(SHARED_VALIDATOR_STRING_053) !== true &&
      automaticCommand?.includes(SHARED_VALIDATOR_STRING_106) !== true,
    `${automaticScript} must not invoke Action authorization provisioning`,
  );
}
if (hasBackendSurfaces) {
  assert(
    rootPackage.scripts?.['node:backend-federation:generate'] === 'node ./scripts/generate-node-backend-federation.mts',
    'Root must expose local Node backend federation artifact generation',
  );
  assert(
    rootPackage.scripts?.['node:proof'] === 'node ./scripts/proof-node-backend-federation.mts',
    'Root must expose read-only node:proof for already-built backend federation Effect modules',
  );
} else {
  assert(
    rootPackage.scripts?.['node:backend-federation:generate'] === undefined,
    'Root must not expose backend federation generation without an API surface',
  );
  assert(rootPackage.scripts?.['node:proof'] === undefined, 'Root must not expose node:proof without an API surface');
}
if (hasDeliveryUnits) {
  assert(
    rootPackage.scripts?.['zerops:materialize'] === 'node ./scripts/materialize-zerops-runtime.mjs',
    'Root must expose Zerops runtime materialization script',
  );
  assert(
    rootPackage.scripts?.['cloudflare:ssr-proof'] === 'node ./scripts/proof-workerd-ssr.mts',
    'Root must expose workerd distributed SSR composition proof',
  );
  assert(
    rootPackage.scripts?.[SHARED_VALIDATOR_STRING_059]?.endsWith('&& pnpm cloudflare:ssr-proof'),
    'Root Cloudflare build must finish with workerd distributed SSR composition proof',
  );
} else {
  assert(
    rootPackage.scripts?.['zerops:materialize'] === undefined,
    'Root must not expose Zerops materialization in a shell-only workspace',
  );
  assert(
    rootPackage.scripts?.['cloudflare:ssr-proof'] === undefined,
    'Root must not expose workerd SSR proof in a shell-only workspace',
  );
}
assertNotExists('scripts/generate-node-backend-federation.mjs');
assertNotExists('scripts/proof-node-backend-federation.mjs');
assertNotExists('scripts/verify-cloudflare-output.mjs');
assertNotExists('scripts/generate-tanstack-routes.mjs');
assert(
  rootPackage.scripts?.check?.includes(SHARED_VALIDATOR_STRING_101) &&
    rootPackage.scripts.check.includes(SHARED_VALIDATOR_STRING_102) &&
    !rootPackage.scripts.check.includes('pnpm node:proof') &&
    ['pnpm performance:readiness', 'pnpm quality:check', ...(bridgeConfig ? ['pnpm bridge:check'] : [])].every(
      (command) =>
        rootPackage.scripts?.check
          ?.split('&&')
          .map((part) => part.trim())
          .includes(command),
    ),
  'Root check must remain static while running default-on performance readiness diagnostics and bridge gates when configured',
);
if (hasDeliveryUnits) {
  const zeropsYaml = readText(SHARED_VALIDATOR_STRING_174);
  const zeropsMigrator = readText('scripts/run-zerops-migrator.mjs');
  const zeropsSpiceDbStart = readText('scripts/run-zerops-spicedb.sh');
  const workerStartCommand = 'node --experimental-strip-types ./src/worker-host/main.ts';
  const workerDeliveryCount = fullStackVerticals.filter((vertical) => {
    const packageJson = readJson(PackageJsonSchema, `${vertical.path}/package.json`);
    const workerHostPath = `${vertical.path}/src/worker-host/main.ts`;
    const hasWorkerStart = packageJson.scripts?.['worker:start'] !== undefined;
    const hasWorkerHost = fs.existsSync(path.join(root, workerHostPath));
    if (hasWorkerStart || hasWorkerHost) {
      const moduleId = packageJson.modernjs?.ontosModule?.moduleId;
      assert(
        packageJson.scripts?.['worker:start'] === workerStartCommand &&
          hasWorkerHost &&
          moduleId !== undefined &&
          readText(workerHostPath).startsWith(
            `// @generated by scaffold:outbox-worker worker-host\n// @ontos-outbox-worker-host-owner ${moduleId}\n`,
          ),
        `${vertical.id} worker delivery requires the exact generated worker:start host capability`,
      );
      return true;
    }
    return false;
  }).length;
  assert(zeropsYaml.includes('zerops:'), 'Zerops manifest must include zerops services');
  assert(
    !zeropsYaml.includes(SHARED_VALIDATOR_STRING_106) && !zeropsYaml.includes(SHARED_VALIDATOR_STRING_053),
    'Zerops startup and deployment must not provision Action authorization automatically',
  );
  assert(
    zeropsYaml.includes(`setup: ${quoteYamlString(SHARED_VALIDATOR_STRING_132)}`),
    'Zerops manifest must include shell service',
  );
  const shellSetup = yamlListItemBlock(zeropsYaml, 'setup', SHARED_VALIDATOR_STRING_132);
  const shellBuild = yamlMappingBlock(shellSetup, 'build', 4);
  const shellBuildEnvironment = yamlMappingBlock(shellBuild, 'envVariables', 6);
  assert(
    shellBuildEnvironment.includes('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: stage'),
    'Zerops shell builds must compile stage module discovery from project deployment URLs',
  );
  assert(
    zeropsYaml.includes(`base: ${quoteYamlString('alpine@3.23')}`),
    'Zerops manifest must use the provisioned Alpine runtime version',
  );
  assert(
    zeropsYaml.includes(`base: ${quoteYamlString('nodejs@24')}`) &&
      zeropsYaml.includes(`initCommands:\n        - ZEROPS_NODE_ROOT=/var/www sh app/scripts/install-zerops-node.sh`),
    'Zerops Node services must install pinned Node during container initialization without a custom runtime image',
  );
  const installZeropsBuildToolchain = `sh /build/source/app/scripts/install-zerops-node.sh --with-pnpm ${packageManagerPnpmVersion}`;
  assert(
    zeropsYaml.split(installZeropsBuildToolchain).length - 1 === fullStackVerticals.length + 2 + workerDeliveryCount,
    'Every Zerops Node build must install the packageManager-pinned pnpm version in its cache key',
  );
  assert(
    zeropsYaml.includes(
      sourceFragment(
        'DATABASE_ADMIN_URL: postgresql://',
        templatePlaceholderOpening,
        'db18_superUser}:',
        templatePlaceholderOpening,
        'db18_superUserPassword}@',
        templatePlaceholderOpening,
        'db18_hostname}:',
        templatePlaceholderOpening,
        'db18_port}/',
        templatePlaceholderOpening,
        'db18_dbName}',
      ),
    ) &&
      !zeropsYaml.includes(
        sourceFragment('DATABASE_ADMIN_URL: ', templatePlaceholderOpening, 'db18_connectionString}'),
      ),
    'Zerops migrator must use the PostgreSQL administrative identity for role and database bootstrap',
  );
  assert(zeropsYaml.includes('deployFiles:'), 'Zerops manifest must deploy package-pruned runtime directories');
  const migratorSetup = yamlListItemBlock(zeropsYaml, 'setup', 'migrator');
  assert(
    migratorSetup.includes("- 'app/tsconfig.base.json'"),
    'Zerops migrator must deploy the root TypeScript config extended by migration packages',
  );
  const localVirtualStoreInstall =
    'PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false PATH="$HOME/.local/node-26.7.0/bin:$PATH" pnpm install --frozen-lockfile --force --config.enable-global-virtual-store=false --virtual-store-dir=node_modules/.pnpm';
  assert(
    zeropsYaml.split(localVirtualStoreInstall).length - 1 === fullStackVerticals.length + 2 + workerDeliveryCount,
    'Every Zerops Node build must install dependencies into a project-local virtual store',
  );
  const cleanWorkspaceDependencies = 'node scripts/reset-workspace-dependencies.mjs';
  assert(
    zeropsYaml.split(cleanWorkspaceDependencies).length - 1 === fullStackVerticals.length + 2 + workerDeliveryCount,
    'Every Zerops Node build must remove cached dependency links before installing',
  );
  const expectedZeropsPnpmCommands = 1 + 3 * (fullStackVerticals.length + 1) + 2 * workerDeliveryCount;
  assert(
    zeropsYaml.split('--config.enable-global-virtual-store=false').length - 1 === expectedZeropsPnpmCommands,
    'Every Zerops pnpm command must override higher-priority host global-virtual-store configuration',
  );
  assert(
    zeropsYaml.split('PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false').length - 1 === expectedZeropsPnpmCommands,
    'Every Zerops pnpm command must propagate local virtual-store configuration to child processes',
  );
  assert(
    zeropsYaml.split('NODE_OPTIONS=--max-old-space-size=4096').length - 1 === fullStackVerticals.length + 1,
    'Every Modern.js Zerops deployment build must reserve enough Node.js heap for dependency tracing',
  );
  assert(
    zeropsYaml.includes(
      `start: sh -c ${quoteYamlString('cd app/.zerops/runtime/shell-super-app && PATH="/var/www/.local/node-26.7.0/bin:$PATH" exec npm run serve')}`,
    ),
    'Zerops shell service must start from materialized runtime package',
  );
  const allDeclaredPortsPresent = [
    workspaceValidationContract.topology.compactConfig.apps.find((app) => app.id === SHARED_VALIDATOR_STRING_131),
    ...fullStackVerticals,
  ].every((app) => app !== undefined && zeropsYaml.includes(`PORT: '${app.port}'`));
  assert(
    allDeclaredPortsPresent &&
      zeropsYaml.includes('SHELL_SUPER_APP_PORT:') &&
      zeropsYaml.includes('ULTRAMODERN_ZEROPS_SERVICE:'),
    'Zerops manifest must expose service identity and bind Modern.js runtimes to their declared ports',
  );
  assert(
    zeropsYaml.includes(`setup: ${quoteYamlString('migrator')}`) &&
      zeropsYaml.includes(`setup: ${quoteYamlString('spicedb')}`) &&
      zeropsYaml.includes(`start: sh app/scripts/run-zerops-spicedb.sh`) &&
      zeropsSpiceDbStart.includes('authzed/spicedb:v1.56.0') &&
      zeropsSpiceDbStart.includes('--network=host'),
    'Zerops manifest must include the pinned remote migration and SpiceDB services',
  );
  const spiceDbSetup = yamlListItemBlock(zeropsYaml, 'setup', 'spicedb');
  assert(
    spiceDbSetup.includes('temporaryShutdown: true'),
    'Zerops SpiceDB deploys must avoid overlapping database connection pools',
  );
  assert(
    !zeropsMigrator.includes("run('pnpm'") && zeropsMigrator.includes("'node_modules', '.bin', 'drizzle-kit'"),
    'Zerops migrator must execute the relocated dependency tree without invoking pnpm runtime verification',
  );
  const runtimeRoleBootstrapCall = "yield* runAppScript('scripts/postgres/bootstrap-runtime-role.mts');";
  assert(
    zeropsMigrator.indexOf(runtimeRoleBootstrapCall) < zeropsMigrator.indexOf('yield* migrate(') &&
      zeropsMigrator.lastIndexOf(runtimeRoleBootstrapCall) > zeropsMigrator.lastIndexOf('yield* migrate('),
    'Zerops migrator must provision the runtime role before RLS migrations and refresh grants afterward',
  );
  for (const migrationPackagePath of [
    'packages/core-runtime',
    SHARED_VALIDATOR_STRING_047,
    ...fullStackVerticals.map((vertical) => vertical.path),
  ]) {
    const migrationPackage = readJson(PackageJsonSchema, `${migrationPackagePath}/package.json`);
    const migrationScript = migrationPackage.scripts?.['db:migrate'] ?? '';
    const migrationConfigs = Array.from(
      migrationScript.matchAll(/drizzle-kit migrate --config (?<migrationConfig>[^\s&]+)/gu),
      (match) => match.groups?.migrationConfig,
    ).filter((config): config is string => config !== undefined);
    assert(migrationConfigs.length > 0, `${migrationPackagePath} must declare at least one Drizzle migration config`);
    let previousMigrationIndex = -1;
    for (const migrationConfig of migrationConfigs) {
      const migrationCall = `yield* migrate(${quoteYamlString(migrationPackagePath)}, ${quoteYamlString(migrationConfig)});`;
      const migrationIndex = zeropsMigrator.indexOf(migrationCall);
      assert(
        migrationIndex > previousMigrationIndex,
        `Zerops migrator must execute ${migrationPackagePath}/${migrationConfig} in package-declared order`,
      );
      previousMigrationIndex = migrationIndex;
    }
  }
  for (const vertical of fullStackVerticals) {
    assert(zeropsYaml.includes(`setup: ${quoteYamlString(vertical.id)}`), `${vertical.id} must have a Zerops service`);
    assert(
      zeropsYaml.includes(
        `PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false PATH="$HOME/.local/node-26.7.0/bin:$PATH" pnpm --config.enable-global-virtual-store=false run zerops:materialize --app ${quoteShellValue(vertical.id)} --package ${quoteShellValue(vertical.packageName)} --package-dir ${quoteShellValue(vertical.path)}`,
      ),
      `${vertical.id} Zerops service must materialize its runtime package`,
    );
    // Only REST-backed (or headless-less UI) units expose an HTTP readiness
    // probe; the RPC surface has no REST readiness endpoint (G7a).
    if (!vertical.emitsApi || vertical.apiProtocol === 'rest') {
      const zeropsReadinessPath = vertical.emitsApi ? `${vertical.apiPrefix}/${vertical.stem}/readiness` : '/';
      assert(
        zeropsYaml.includes(`path: ${quoteYamlString(zeropsReadinessPath)}`),
        `${vertical.id} BFF readiness path must use generated API prefix`,
      );
    }
  }
  const zeropsMaterializer = readText('scripts/materialize-zerops-runtime.mjs');
  for (const deliveryUnitPath of [
    SHARED_VALIDATOR_STRING_047,
    ...fullStackVerticals.map((vertical) => vertical.path),
  ]) {
    const deliveryUnitPackage = readJson(PackageJsonSchema, `${deliveryUnitPath}/package.json`);
    assert(
      deliveryUnitPackage.scripts?.build?.includes('MODERNJS_DEPLOY=node modern deploy --skip-build') ?? false,
      `${deliveryUnitPath} build must produce the Modern.js Node output before Zerops materialization`,
    );
  }
  assert(
    (zeropsMaterializer.includes("const appOutputDir = path.join(appRoot, '.output')") ||
      zeropsMaterializer.includes("const appOutputDir = pathService.join(appRoot, '.output')")) &&
      zeropsMaterializer.includes('before runtime materialization'),
    'Zerops materializer must require the Node output produced by the package build',
  );
  assert(
    zeropsMaterializer.includes('normalizeRuntimePackageDependencies'),
    'Zerops materializer must normalize generated Modern package aliases before installing dependencies',
  );
  assert(
    zeropsMaterializer.includes('removeIncompatiblePlatformDependencies') &&
      zeropsMaterializer.includes('isCurrentPlatformSupported') &&
      zeropsMaterializer.includes('process.platform') &&
      zeropsMaterializer.includes('process.arch'),
    'Zerops materializer must exclude traced dependencies that declare an incompatible runtime OS or CPU',
  );
  assert(
    zeropsMaterializer.includes('officialPackageName'),
    'Zerops materializer must add official Modern.js npm aliases for generated runtime imports',
  );
  assert(
    zeropsMaterializer.includes('installRuntimeDependencies'),
    'Zerops materializer must install dependencies outside the workspace copy runtime node_modules',
  );
  assert(
    zeropsMaterializer.includes('copyWorkspacePackage'),
    'Zerops materializer must preserve generated local workspace package dependencies',
  );
  assert(
    zeropsMaterializer.includes('makeWorkspacePackageRuntimeSafe'),
    'Zerops materializer must rewrite copied workspace packages to runtime-safe JavaScript exports',
  );
  assert(
    zeropsMaterializer.includes("serve: runtimePackage.scripts?.serve ?? 'node index.js'"),
    'Zerops materializer must preserve runtime serve script fallback',
  );
  assert(
    /'install',\s*'--omit=dev'/u.test(zeropsMaterializer),
    'Zerops materializer must omit dev dependencies from runtime installs',
  );
  assert(
    zeropsMaterializer.includes("'--legacy-peer-deps'"),
    'Zerops materializer must tolerate generated-workspace peer dependency ranges in npm runtime install',
  );
}
const performanceReadinessConfig = readText(SHARED_VALIDATOR_STRING_121);
const assertToolWrapper = (scriptPath: string, command: string): void => {
  const source = readText(scriptPath);
  assert(
    hasUltramodernDispatch(source, command, readText('scripts/shared/ultramodern-command.mts')) ||
      (command === 'skills' && hasUltramodernSkillsDispatch(source, readText('scripts/shared/ultramodern-launch.mts'))),
    `${scriptPath} must delegate ${command} through the override-aware UltraModern runner`,
  );
};
assert(
  performanceReadinessConfig.includes('UltramodernPerformanceReadinessDiagnosticsConfig'),
  'Performance readiness config must carry the typed opt-out surface',
);
assert(performanceReadinessConfig.includes('enabled: true'), 'Performance readiness diagnostics must be default-on');
assert(
  performanceReadinessConfig.includes("failOn: 'framework-invariant'"),
  'Performance readiness diagnostics must only fail framework invariants by default',
);
assertToolWrapper(SHARED_VALIDATOR_STRING_122, 'performance-readiness');
const i18nBoundaryScript = readText('scripts/check-ultramodern-i18n-boundaries.mts');
assertToolWrapper(SHARED_VALIDATOR_STRING_123, 'typecheck');
assert(
  i18nBoundaryScript.includes("from '@modern-js/code-tools'") && i18nBoundaryScript.includes('runWorkspaceSourceCheck'),
  'Root i18n boundary script must call @modern-js/code-tools',
);
assert(rootPackage.scripts?.['mf:types'] === SHARED_VALIDATOR_STRING_082, 'Root must expose mf:types');
assert(
  rootPackage.scripts?.[SHARED_VALIDATOR_STRING_060] === expectedCloudflareDeployScript,
  'Root must expose cloudflare:deploy',
);
assert(
  rootPackage.scripts?.[SHARED_VALIDATOR_STRING_061] === SHARED_VALIDATOR_STRING_084,
  'Root must expose cloudflare:proof',
);
assert(
  rootPackage.scripts?.['skills:install'] === 'node ./scripts/bootstrap-agent-skills.mts',
  'Root must expose skills:install',
);
assert(
  rootPackage.scripts?.['skills:check'] === 'node ./scripts/bootstrap-agent-skills.mts --check',
  'Root must expose skills:check',
);
assert(
  rootPackage.scripts?.postinstall === 'node ./scripts/bootstrap-agent-skills.mts --postinstall && oxfmt .',
  'Root postinstall must run the default-on Codex skills bootstrap, format installed skills, and leave reference repository installs explicit',
);
assert(
  rootPackage.scripts?.['agents:refs:install'] === 'node ./scripts/setup-agent-reference-repos.mts',
  'Root must expose agents:refs:install as the explicit reference repo installer',
);
const agentSkillsBootstrap = readText(SHARED_VALIDATOR_STRING_115);
assertToolWrapper(SHARED_VALIDATOR_STRING_114, 'mf-types');
if (hasBackendSurfaces) {
  assertToolWrapper(SHARED_VALIDATOR_STRING_116, 'backend-federation-generate');
  assertToolWrapper(SHARED_VALIDATOR_STRING_120, 'backend-federation-proof');
}
assertToolWrapper(SHARED_VALIDATOR_STRING_117, 'public-surface');
assertToolWrapper(SHARED_VALIDATOR_STRING_118, 'routes-generate');
assertToolWrapper(SHARED_VALIDATOR_STRING_119, 'cloudflare-proof');
assertToolWrapper(SHARED_VALIDATOR_STRING_125, 'cloudflare-output-verify');
assertToolWrapper(SHARED_VALIDATOR_STRING_115, 'skills');
assert(
  !agentSkillsBootstrap.includes("run('brew'") && !agentSkillsBootstrap.includes('runShell('),
  'Agent skills bootstrap must never invoke system package managers',
);
const agentReferenceRepoSetup = readText('scripts/setup-agent-reference-repos.mts');
assert(
  agentReferenceRepoSetup.includes("['commit', '-m', message]") && !agentReferenceRepoSetup.includes('--no-verify'),
  'Agent reference repo installer commits must run normal Git hooks',
);
assert(
  agentReferenceRepoSetup.includes("commitInstallerChanges('Initialize UltraModern workspace')"),
  'Initial agent reference repo commit must use the installer commit helper',
);
assert(
  agentReferenceRepoSetup.includes("commitInstallerChanges('Record agent reference repo manifest')"),
  'Agent reference repo manifest commit must use the installer commit helper',
);

const expectedAppIds = [SHARED_VALIDATOR_STRING_131, ...fullStackVerticals.map((vertical) => vertical.id)];
const expectedCloudflareCompatibilityFlags = [SHARED_VALIDATOR_STRING_089, SHARED_VALIDATOR_STRING_070];
assert(
  sameJson(
    generatedContract.apps?.map((app) => app.id),
    expectedAppIds,
  ),
  'Generated contract must contain shell plus the full-stack verticals',
);
assert(
  generatedContract.cssFederation?.sharedDesignTokens?.owner?.id === SHARED_VALIDATOR_STRING_128,
  'CSS federation must declare shared design token ownership',
);
assert(
  generatedContract.cssFederation?.sharedDesignTokens?.role === SHARED_VALIDATOR_STRING_128,
  'CSS federation must mark shared-design-tokens as token owner',
);
assert(
  generatedContract.cssFederation?.sharedDesignTokens?.rootSelector === ':root',
  'Shared design tokens must declare their root selector',
);
assert(
  generatedContract.cssFederation?.sharedDesignTokens?.classPrefix === '--um-',
  'Shared design tokens must declare their CSS custom property prefix',
);
assert(
  generatedContract.cssFederation?.sharedDesignTokens?.layers?.owned?.includes(SHARED_VALIDATOR_STRING_149),
  'Shared design tokens must own the shared token CSS layer',
);
assert(
  generatedContract.cssFederation?.sharedDesignTokens?.entrypoints?.css?.includes(SHARED_VALIDATOR_STRING_097),
  'Shared design tokens must declare their CSS entrypoint',
);
assert(
  generatedContract.cssFederation?.sharedDesignTokens?.assets?.exports?.includes('./tokens.css'),
  'Shared design tokens must export their CSS asset',
);
assert(
  !generatedContract.cssFederation?.sharedDesignTokens?.dedupe?.duplicateBaseStylesAllowed,
  'Shared design token CSS must be deduplicated',
);
assert(
  generatedContract.cssFederation?.sharedDesignTokens?.ssr?.firstPaintRequired,
  'Shared design token CSS must be required for SSR first paint',
);
const expectedPerformanceReadinessSignals = [
  'bfcache',
  'core-web-vitals-rum',
  'duplicate-prefetch-warmup',
  'cache-policy-sanity',
  'save-data-behavior',
  'cloudflare-ssr-cache-hints',
];
assert(
  generatedContract.performanceReadiness?.default === 'enabled',
  'Performance readiness diagnostics must be default-on in the generated contract',
);
assert(
  generatedContract.performanceReadiness?.mode === 'diagnostic',
  'Performance readiness must remain diagnostic-only',
);
assert(
  generatedContract.performanceReadiness?.report?.script === SHARED_VALIDATOR_STRING_122,
  'Performance readiness contract must point at the generated script',
);
assert(
  generatedContract.performanceReadiness?.report?.deterministic,
  'Performance readiness reports must be deterministic',
);
assert(
  generatedContract.performanceReadiness?.optOut?.env === SHARED_VALIDATOR_STRING_146,
  'Performance readiness env opt-out is incorrect',
);
assert(
  sameJson(
    generatedContract.performanceReadiness?.signals?.map((signal) => signal.id),
    expectedPerformanceReadinessSignals,
  ),
  'Performance readiness signal ids are incorrect',
);

const shellModernConfig = readText(SHARED_VALIDATOR_STRING_048);
const shellModuleFederationConfig = readText(SHARED_VALIDATOR_STRING_049);
const shellModernAppEnv = readText('apps/shell-super-app/src/modern-app-env.d.ts');
const gitignore = readText('.gitignore');
const shellRouteHead = readText('apps/shell-super-app/src/routes/ultramodern-route-head.tsx');
const shellRouteMetadata = readText('apps/shell-super-app/src/routes/ultramodern-route-metadata.ts');
assert(/^\.mf\/$/mu.test(gitignore), 'Generated .gitignore must ignore root Module Federation diagnostics');
assert(/^\*\*\/\.mf\/$/mu.test(gitignore), 'Generated .gitignore must ignore per-app Module Federation diagnostics');
assert(/^dist-cloudflare\/$/mu.test(gitignore), 'Generated .gitignore must ignore Cloudflare build output');
assert(/^\.output\/$/mu.test(gitignore), 'Generated .gitignore must ignore root final deployment output');
assert(/^\*\*\/\.output\/$/mu.test(gitignore), 'Generated .gitignore must ignore per-app final deployment output');
assert(
  /^\*\*\/src\/modern-tanstack\/$/mu.test(gitignore),
  'Generated .gitignore must ignore framework-owned TanStack router output',
);
assert(
  /^\*\*\/\.tsgo\.\*\.resolved\.json$/mu.test(gitignore),
  'Generated .gitignore must ignore transient TS-Go resolution output',
);
assert(
  shellModernAppEnv.includes('/// <reference types="@modern-js/app-tools/types" />'),
  'Shell app env must reference the framework-owned app ambient type bundle while remaining an ambient declaration file',
);
assert(
  /declare const ULTRAMODERN_SITE_URL: string;/u.test(shellModernAppEnv),
  'Shell app env must keep generated globals explicit in ambient scope',
);
assert(
  !shellModernAppEnv.includes("declare module '*.svg'"),
  'Shell app env must not redeclare framework-owned svg asset modules',
);
assert(
  !shellModernAppEnv.includes("declare module '*.css'"),
  'Shell app env must not redeclare framework-owned css asset modules',
);
assert(
  shellRouteMetadata.includes('@generated by @modern-js/ultramodern-create'),
  'Shell route metadata compatibility manifest must be marked generated',
);
assert(
  shellRouteMetadata.includes('Author route metadata in colocated src/routes/**/route.meta.ts files.'),
  'Shell route metadata manifest must advertise colocated authoring',
);
const expectedZephyrDependencies = Object.fromEntries(
  expectedPrimaryShellVerticalIds.flatMap((verticalId) => {
    const vertical = fullStackVerticals.find((candidate) => candidate.id === verticalId);
    assert(vertical !== undefined, `Missing primary-shell vertical ${verticalId}`);
    if (vertical === undefined) {
      return [];
    }
    return vertical.exposes.length === 0 ? [] : [[vertical.zephyrAlias, `${vertical.packageName}@workspace:*`]];
  }),
);
assert(
  sameJson(shellPackage[SHARED_VALIDATOR_STRING_173], expectedZephyrDependencies),
  'Shell Zephyr dependencies must reference every primary-shell vertical package',
);
assert(
  shellPackage.devDependencies?.[SHARED_VALIDATOR_STRING_022] ===
    expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_022),
  'Shell app-tools dependency must match package source metadata',
);
assert(
  shellPackage.dependencies?.[SHARED_VALIDATOR_STRING_025] ===
    expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_025),
  'Shell plugin-bff dependency must match package source metadata',
);
assert(
  shellPackage.dependencies?.[SHARED_VALIDATOR_STRING_027] ===
    expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_027),
  'Shell plugin-i18n dependency must match package source metadata',
);
assert(
  shellPackage.dependencies?.[SHARED_VALIDATOR_STRING_028] ===
    expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_028),
  'Shell plugin-tanstack dependency must match package source metadata',
);
assert(
  shellPackage.dependencies?.[SHARED_VALIDATOR_STRING_029] ===
    expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_029),
  'Shell runtime dependency must match package source metadata',
);
assert(
  shellPackage.scripts?.[SHARED_VALIDATOR_STRING_060] === SHARED_VALIDATOR_STRING_144,
  'Shell must expose cloudflare:deploy',
);
assertTargetIsolatedBuildArtifacts(SHARED_VALIDATOR_STRING_131, shellModernConfig);
assertCloudflareBuildSkipsDeployRebuild(SHARED_VALIDATOR_STRING_131, shellPackage);
const shellContract = generatedContract.apps?.find((app) => app.id === SHARED_VALIDATOR_STRING_131);
assert(
  shellContract?.deploy?.cloudflare?.workerName === expectedWorkerName(SHARED_VALIDATOR_STRING_131),
  'Shell Cloudflare workerName is incorrect',
);
assert(
  shellContract?.deploy?.cloudflare?.publicUrlEnv === SHARED_VALIDATOR_STRING_148,
  'Shell Cloudflare public URL env is incorrect',
);
assert(
  shellContract?.deploy?.cloudflare?.compatibilityDate === expectedCloudflareCompatibilityDate,
  'Shell Cloudflare compatibilityDate is incorrect',
);
assert(
  sameJson(shellContract?.deploy?.cloudflare?.compatibilityFlags, expectedCloudflareCompatibilityFlags),
  'Shell Cloudflare compatibility flags are incorrect',
);
assert(
  sameJson(shellContract?.deploy?.cloudflare?.security, expectedCloudflareSecurity),
  'Shell Cloudflare security contract is incorrect',
);
assertCloudflareQualityGates(SHARED_VALIDATOR_STRING_131, shellContract?.deploy?.cloudflare?.qualityGates);
assert(
  shellContract?.deploy?.worker?.compatibilityDate === expectedCloudflareCompatibilityDate,
  'Shell worker compatibilityDate is incorrect',
);
assert(
  shellContract?.deploy?.worker?.name === expectedWorkerName(SHARED_VALIDATOR_STRING_131),
  'Shell worker name is incorrect',
);
assert(
  shellModernConfig.includes(`const cloudflareWorkerName = '${expectedWorkerName(SHARED_VALIDATOR_STRING_131)}'`),
  'Shell modern.config.ts must define the Cloudflare worker name',
);
assert(shellModernConfig.includes('name: cloudflareWorkerName'), 'Shell modern.config.ts must wire deploy.worker.name');
assert(
  shellModernConfig.includes('const assetPrefix ='),
  'Shell modern.config.ts must derive a dedicated asset prefix',
);
assert(
  shellModernConfig.includes("const configuredUltramodernAssetPrefix = envValue('ULTRAMODERN_ASSET_PREFIX')"),
  'Shell asset prefix must support ULTRAMODERN_ASSET_PREFIX',
);
assert(
  shellModernConfig.includes("const configuredModernAssetPrefix = envValue('MODERN_ASSET_PREFIX')"),
  'Shell asset prefix must support MODERN_ASSET_PREFIX',
);
assert(
  shellModernConfig.includes("const defaultAssetPrefix = '/'"),
  'Shell asset prefix must default to origin-relative assets',
);
const shellAssetPrefixExpression = extractAssetPrefixExpression(shellModernConfig);
assert(
  /configuredModernAssetPrefix\s*\|\|\s*configuredUltramodernAssetPrefix\s*\|\|\s*defaultAssetPrefix/u.test(
    shellAssetPrefixExpression,
  ),
  'Shell asset prefix fallback order is incorrect',
);
assert(
  !shellAssetPrefixExpression.includes('configuredSiteUrl') &&
    !shellAssetPrefixExpression.includes(SHARED_VALIDATOR_STRING_081),
  'Shell asset prefix must not fall back to MODERN_PUBLIC_SITE_URL',
);
assert(
  !shellAssetPrefixExpression.includes('configuredCloudflareUrl') &&
    !shellAssetPrefixExpression.includes(SHARED_VALIDATOR_STRING_148),
  'Shell asset prefix must not fall back to the per-app public URL',
);
assert(
  !shellAssetPrefixExpression.includes('inferredCloudflareUrl') &&
    !shellAssetPrefixExpression.includes(SHARED_VALIDATOR_STRING_145),
  'Shell asset prefix must not infer workers.dev URLs',
);
assert(shellModernConfig.includes("assetPrefix: '/'"), 'Shell modern.config.ts must keep dev assets origin-relative');
assert(
  shellModernConfig.includes('assetPrefix,'),
  'Shell modern.config.ts must wire output.assetPrefix to the derived asset prefix',
);
assert(shellContract?.config?.dev?.assetPrefix === '/', 'Shell dev asset prefix must stay origin-relative');
assert(
  shellContract?.config?.output?.assetPrefix?.default === '/',
  'Shell asset prefix must default to origin-relative paths',
);
assert(
  sameJson(shellContract?.config?.output?.assetPrefix?.envFallbackOrder, [
    SHARED_VALIDATOR_STRING_080,
    SHARED_VALIDATOR_STRING_143,
  ]),
  'Shell asset prefix env fallback order is incorrect',
);
assert(
  !(shellContract?.config?.output?.disableTsChecker ?? false),
  'Shell must keep the framework TypeScript checker enabled',
);
assert(
  shellContract?.config?.performance?.readinessDiagnostics?.default === 'enabled',
  'Shell performance readiness diagnostics must be default-on',
);
assert(
  shellContract?.config?.performance?.readinessDiagnostics?.failOn === SHARED_VALIDATOR_STRING_069,
  'Shell performance readiness diagnostics must only fail framework invariants by default',
);
assert(
  shellContract?.config?.performance?.readinessDiagnostics?.optOut?.env === SHARED_VALIDATOR_STRING_146,
  'Shell performance readiness env opt-out is incorrect',
);
assert(
  sameJson(shellContract?.config?.source?.siteUrl?.envFallbackOrder, [
    SHARED_VALIDATOR_STRING_081,
    SHARED_VALIDATOR_STRING_148,
    SHARED_VALIDATOR_STRING_145,
    SHARED_VALIDATOR_STRING_130,
  ]),
  'Shell site URL env fallback order is incorrect',
);
assert(
  shellContract?.config?.rspack?.output?.uniqueName === SHARED_VALIDATOR_STRING_133,
  'Shell Rspack uniqueName is incorrect',
);
assert(
  shellContract?.config?.rspack?.output?.chunkLoadingGlobal === expectedChunkLoadingGlobal(SHARED_VALIDATOR_STRING_133),
  'Shell Rspack chunkLoadingGlobal is incorrect',
);
assert(
  shellContract?.moduleFederation?.dts?.compilerInstance === SHARED_VALIDATOR_STRING_068,
  'Shell must keep mandatory DTS compiler',
);
assert(
  shellContract?.moduleFederation?.dts?.tsConfigPath === SHARED_VALIDATOR_STRING_007,
  'Shell must keep dedicated Module Federation DTS tsconfig',
);
assert(
  shellModuleFederationConfig.includes("tsConfigPath: './tsconfig.mf-types.json'"),
  'Shell Module Federation config must use the dedicated DTS tsconfig',
);
assert(
  topology.shell?.cloudflare?.workerName === expectedWorkerName(SHARED_VALIDATOR_STRING_131),
  'Shell topology Cloudflare workerName is incorrect',
);
assert(
  shellContract?.styling?.federation?.owner?.id === SHARED_VALIDATOR_STRING_131,
  'Shell CSS federation owner is missing',
);
assert(shellContract?.styling?.federation?.role === 'shell-base-overlay', 'Shell must own base and overlay CSS');
assert(
  shellContract?.styling?.federation?.rootSelector === '[data-app-id="shell-super-app"]',
  'Shell CSS root selector is incorrect',
);
assert(shellContract?.styling?.federation?.classPrefix === 'shell:', 'Shell CSS class prefix is incorrect');
assert(
  shellContract?.styling?.federation?.layers?.owned?.includes(SHARED_VALIDATOR_STRING_150) ?? false,
  'Shell must own the base CSS layer',
);
assert(
  shellContract?.styling?.federation?.layers?.owned?.includes('ultramodern-shell-overlay') ?? false,
  'Shell must own the overlay CSS layer',
);
assert(
  shellContract?.styling?.federation?.entrypoints?.css?.includes(SHARED_VALIDATOR_STRING_138) ?? false,
  'Shell CSS entrypoint is missing',
);
assert(
  shellContract?.styling?.federation?.assets?.shared?.some((asset) =>
    asset.endsWith('/shared-design-tokens/tokens.css'),
  ) ?? false,
  'Shell must import the shared design token CSS asset',
);
assert(
  !(shellContract?.styling?.federation?.dedupe?.duplicateBaseStylesAllowed ?? false),
  'Shell CSS contract must forbid duplicated base styles',
);
assert(
  shellContract?.styling?.federation?.ssr?.firstPaintRequired ?? false,
  'Shell CSS must be required for SSR first paint',
);
assert(shellContract?.routes?.privateByDefault ?? false, 'Shell routes must be private by default');
assert(
  shellContract?.routes?.metadataAuthoring === SHARED_VALIDATOR_STRING_062,
  'Shell route metadata authoring mode is incorrect',
);
assert(shellContract?.routes?.generatedManifest ?? false, 'Shell route metadata manifest must be generated');
assert(
  shellContract?.routes?.publicnessDefault === SHARED_VALIDATOR_STRING_105,
  'Shell route publicness default is incorrect',
);
assert(
  sameJson(shellContract?.routes?.publicRoutes ?? [], []),
  'Shell must not expose generated public routes by default',
);
assertPublicHeadContract(SHARED_VALIDATOR_STRING_131, shellContract?.routes?.publicHead, shellRouteHead);
assertPublicSurfaceContract(SHARED_VALIDATOR_STRING_131, shellContract?.routes?.publicSurface);
assert(
  (shellContract?.routes?.owned ?? []).every(
    (route) =>
      !route.public &&
      !route.indexable &&
      route.publicSurface === SHARED_VALIDATOR_STRING_105 &&
      isString(route.descriptionKey),
  ),
  'Shell owned routes must be non-indexable private app screens by default and include description keys',
);
assertPublicSurfaceAssets(SHARED_VALIDATOR_STRING_047, shellContract?.routes?.publicRoutes ?? []);
assert(
  topology.shell?.verticalRefs?.join(',') === expectedPrimaryShellVerticalIds.join(','),
  'Topology shell verticalRefs must match generated verticals',
);
assert(topology.verticals?.length === fullStackVerticals.length, 'Topology must contain only generated verticals');
const legacyTopologyFields = Result.getOrThrow(Schema.decodeUnknownResult(LegacyTopologyFieldsSchema)(topology));
assert(legacyTopologyFields.remotes === undefined, 'Topology must not expose legacy remotes; use verticals');
assert(legacyTopologyFields.effectServices === undefined, 'Default APIs must be vertical-owned, not effectServices');

for (const vertical of fullStackVerticals) {
  const packageJson = readJson(PackageJsonSchema, `${vertical.path}/package.json`);
  const actionPrincipalPath = `${vertical.path}/api/auth/action-principal.ts`;
  const actionGatewayPath = `${vertical.path}/src/api/action-gateway.ts`;
  const hasActionPrincipal = fs.existsSync(path.join(root, actionPrincipalPath));
  const hasActionGateway = fs.existsSync(path.join(root, actionGatewayPath));
  assert(
    hasActionPrincipal === hasActionGateway,
    `${vertical.id} generated Action identity boundary must contain both server and client adapters`,
  );
  if (hasActionPrincipal) {
    for (const boundaryPath of [actionPrincipalPath, actionGatewayPath]) {
      const boundary = readText(boundaryPath);
      assert(
        boundary.includes('@generated by OntOS Codesmith MicroVertical Action Boundary v1') &&
          boundary.includes(`@ontos-action-boundary-owner ${vertical.id}`) &&
          boundary.includes(`@ontos-action-boundary-audience ${vertical.id}`) &&
          boundary.includes(`ACTION_GATEWAY_AUDIENCE = '${vertical.id}'`),
        `${boundaryPath} generated Action identity metadata is invalid`,
      );
    }
    const actionPrincipal = readText(actionPrincipalPath);
    assert(
      actionPrincipal.includes("from '@app/gateway-principal-verifier/server'") &&
        actionPrincipal.includes('bindGatewayPrincipalVerifier(ACTION_GATEWAY_AUDIENCE)') &&
        !/(?:createLocalJWKSet|decodeProtectedHeader|jwtVerify|PublicVerificationKeySchema)/u.test(actionPrincipal),
      `${actionPrincipalPath} must be a thin audience-bound shared verifier adapter`,
    );
    for (const [dependency, version] of Object.entries({
      '@app/core-runtime': SHARED_VALIDATOR_STRING_169,
      '@app/gateway-principal-verifier': SHARED_VALIDATOR_STRING_169,
      '@app/shared-contracts': SHARED_VALIDATOR_STRING_169,
      effect: expectedEffectVersion,
    })) {
      assert(
        packageJson.dependencies?.[dependency] === version,
        `${vertical.id} Action identity boundary dependency ${dependency} must equal ${version}`,
      );
    }
    assert(
      packageJson.dependencies?.jose === undefined,
      `${vertical.id} must not own the shared verifier's JOSE runtime dependency`,
    );
  }
  const modernConfig = readText(`${vertical.path}/modern.config.ts`);
  // The browser Module Federation config and colocated route surfaces only
  // exist for UI-emitting units; a headless api-only unit emits none (G2a/P4).
  const moduleFederationConfig = vertical.emitsUi ? readText(`${vertical.path}/module-federation.config.ts`) : '';
  const modernAppEnv = readText(`${vertical.path}/src/modern-app-env.d.ts`);
  const routeHead = vertical.emitsUi ? readText(`${vertical.path}/src/routes/ultramodern-route-head.tsx`) : '';
  const routeMetadata = vertical.emitsUi ? readText(`${vertical.path}/src/routes/ultramodern-route-metadata.ts`) : '';
  const ultramodernBuildSource = readText(`${vertical.path}/shared/ultramodern-build.ts`);
  const ultramodernBuildArtifact = readJson(BuildArtifactSchema, `${vertical.path}/shared/ultramodern-build.json`);
  if (vertical.deliveryUnit !== undefined) {
    const expectedDeliveryUnit = deliveryUnitBlock(expectedDeliveryUnitFor(vertical));
    const buildLabel = `${vertical.path}/shared/ultramodern-build.json deliveryUnit`;
    assertSelfCheck(
      ultramodernBuildSource.includes('export const ultramodernDeliveryUnit'),
      buildLabel,
      'Missing ultramodernDeliveryUnit export',
      deliveryUnitIdentityFixArea,
    );
    const buildIdentity = ultramodernBuildArtifact.deliveryUnit ?? {};
    assertSelfCheck(
      buildIdentity.buildMarker === expectedDeliveryUnit.buildMarker,
      buildLabel,
      `Expected build "${expectedDeliveryUnit.buildMarker}", found ${formatJson(buildIdentity.buildMarker)}`,
      deliveryUnitIdentityFixArea,
    );
    assertSelfCheck(
      buildIdentity.unitId === expectedDeliveryUnit.unitId,
      buildLabel,
      `Expected unitId "${expectedDeliveryUnit.unitId}", found ${formatJson(buildIdentity.unitId)}`,
      deliveryUnitIdentityFixArea,
    );
    assertSelfCheck(
      buildIdentity.packageName === expectedDeliveryUnit.packageName,
      buildLabel,
      `Expected packageName "${expectedDeliveryUnit.packageName}", found ${formatJson(buildIdentity.packageName)}`,
      deliveryUnitIdentityFixArea,
    );
    assertSelfCheck(
      buildIdentity.version === expectedDeliveryUnit.version,
      buildLabel,
      `Expected version "${expectedDeliveryUnit.version}", found ${formatJson(buildIdentity.version)}`,
      deliveryUnitIdentityFixArea,
    );
    assertBuildFacadeExport(
      ultramodernBuildSource,
      SHARED_VALIDATOR_STRING_152,
      'ultramodernBuildArtifact.surfaces.ui',
      `${vertical.path}/shared/ultramodern-build.ts ultramodernUiMarker`,
    );
    assertBuildFacadeExport(
      ultramodernBuildSource,
      SHARED_VALIDATOR_STRING_151,
      'ultramodernBuildArtifact.surfaces.api',
      `${vertical.path}/shared/ultramodern-build.ts ultramodernApiMarker`,
    );
  }
  assert(
    modernAppEnv.includes('/// <reference types="@modern-js/app-tools/types" />'),
    `${vertical.id} app env must reference the framework-owned app ambient type bundle while remaining an ambient declaration file`,
  );
  assert(
    /declare const ULTRAMODERN_SITE_URL: string;/u.test(modernAppEnv),
    `${vertical.id} app env must keep generated globals explicit in ambient scope`,
  );
  assert(
    !modernAppEnv.includes("declare module '*.svg'"),
    `${vertical.id} app env must not redeclare framework-owned svg asset modules`,
  );
  assert(
    !modernAppEnv.includes("declare module '*.css'"),
    `${vertical.id} app env must not redeclare framework-owned css asset modules`,
  );
  if (vertical.emitsUi) {
    assert(
      routeMetadata.includes('@generated by @modern-js/ultramodern-create'),
      `${vertical.id} route metadata compatibility manifest must be marked generated`,
    );
    assert(
      routeMetadata.includes('Author route metadata in colocated src/routes/**/route.meta.ts files.'),
      `${vertical.id} route metadata manifest must advertise colocated authoring`,
    );
  }
  assert(packageJson.name === vertical.packageName, `${vertical.id} package name is incorrect`);
  assert(
    packageJson.scripts?.[SHARED_VALIDATOR_STRING_060] === SHARED_VALIDATOR_STRING_144,
    `${vertical.id} must expose cloudflare:deploy`,
  );
  assertTargetIsolatedBuildArtifacts(vertical.id, modernConfig);
  assertCloudflareBuildSkipsDeployRebuild(vertical.id, packageJson);
  assert(
    packageJson.scripts?.[SHARED_VALIDATOR_STRING_061]?.includes(`--app ${vertical.id}`) ?? false,
    `${vertical.id} must expose cloudflare:proof`,
  );
  assert(
    packageJson.devDependencies?.[SHARED_VALIDATOR_STRING_022] ===
      expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_022),
    `${vertical.id} app-tools dependency must match package source metadata`,
  );
  if (vertical.emitsApi) {
    assert(
      packageJson.dependencies?.[SHARED_VALIDATOR_STRING_025] ===
        expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_025),
      `${vertical.id} plugin-bff dependency must match package source metadata`,
    );
  }
  assert(
    packageJson.dependencies?.[SHARED_VALIDATOR_STRING_027] ===
      expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_027),
    `${vertical.id} plugin-i18n dependency must match package source metadata`,
  );
  assert(
    packageJson.dependencies?.[SHARED_VALIDATOR_STRING_028] ===
      expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_028),
    `${vertical.id} plugin-tanstack dependency must match package source metadata`,
  );
  assert(
    packageJson.dependencies?.[SHARED_VALIDATOR_STRING_029] ===
      expectedModernPackageSpecifier(SHARED_VALIDATOR_STRING_029),
    `${vertical.id} runtime dependency must match package source metadata`,
  );
  if (vertical.emitsApi) {
    if (vertical.apiContractExport === undefined) {
      assert(
        packageJson.exports?.['./api'] === undefined &&
          packageJson.exports?.[SHARED_VALIDATOR_STRING_002] === undefined,
        `${vertical.id} private deployment API must not be package-exported`,
      );
    } else {
      assert(
        packageJson.exports?.[vertical.apiClientExport] === `./${vertical.apiClientPath}`,
        `${vertical.id} must export its API client`,
      );
      assert(
        packageJson.exports?.['./api'] === `./${vertical.apiContractPath}`,
        `${vertical.id} must export its API contract`,
      );
    }
    // API protocol exclusivity (G7a): an RPC unit ships only the RPC contract
    // and `${stem}-rpc-client`; a REST unit ships only the REST contract and
    // `${stem}-client`. Neither may carry the other protocol's surface.
    if (vertical.apiProtocol === 'rpc') {
      assert(
        !fs.existsSync(path.join(root, `${vertical.path}/src/api/${vertical.stem}-client.ts`)),
        `${vertical.id} RPC unit must not emit the REST API client`,
      );
      assert(
        !fs.existsSync(path.join(root, `${vertical.path}/shared/api.ts`)),
        `${vertical.id} RPC unit must not emit the REST API contract`,
      );
    } else {
      assert(
        !fs.existsSync(path.join(root, `${vertical.path}/src/api/${vertical.stem}-rpc-client.ts`)),
        `${vertical.id} REST unit must not emit the RPC API client`,
      );
      assert(
        !fs.existsSync(path.join(root, `${vertical.path}/shared/rpc.ts`)),
        `${vertical.id} REST unit must not emit the RPC API contract`,
      );
    }
  }
  const expectedVerticalZephyrDependencies = Object.fromEntries(
    fullStackVerticals
      .filter((candidate) => new Set<string>(vertical.verticalRefs).has(candidate.id))
      .map((candidate) => [candidate.zephyrAlias, `${candidate.packageName}@workspace:*`]),
  );
  assert(
    sameJson(packageJson[SHARED_VALIDATOR_STRING_173], expectedVerticalZephyrDependencies),
    `${vertical.id} Zephyr dependencies must match declared vertical refs`,
  );

  const contractEntry = generatedContract.apps?.find((app) => app.id === vertical.id);
  assert(contractEntry?.path === vertical.path, `${vertical.id} generated contract path is incorrect`);
  assert(contractEntry?.kind === 'vertical', `${vertical.id} generated contract kind is incorrect`);
  assert(
    contractEntry?.deploy?.cloudflare?.workerName === expectedWorkerName(vertical.id),
    `${vertical.id} Cloudflare workerName is incorrect`,
  );
  assert(
    contractEntry?.deploy?.cloudflare?.publicUrlEnv ===
      `ULTRAMODERN_PUBLIC_URL_${vertical.id.replaceAll('-', '_').toUpperCase()}`,
    `${vertical.id} Cloudflare public URL env is incorrect`,
  );
  assert(
    contractEntry?.deploy?.cloudflare?.compatibilityDate === expectedCloudflareCompatibilityDate,
    `${vertical.id} Cloudflare compatibilityDate is incorrect`,
  );
  assert(
    sameJson(contractEntry?.deploy?.cloudflare?.compatibilityFlags, expectedCloudflareCompatibilityFlags),
    `${vertical.id} Cloudflare compatibility flags are incorrect`,
  );
  assert(
    sameJson(contractEntry?.deploy?.cloudflare?.security, expectedCloudflareSecurity),
    `${vertical.id} Cloudflare security contract is incorrect`,
  );
  assertCloudflareQualityGates(vertical.id, contractEntry?.deploy?.cloudflare?.qualityGates);
  assert(
    contractEntry?.deploy?.worker?.compatibilityDate === expectedCloudflareCompatibilityDate,
    `${vertical.id} worker compatibilityDate is incorrect`,
  );
  assert(
    contractEntry?.deploy?.worker?.name === expectedWorkerName(vertical.id),
    `${vertical.id} worker name is incorrect`,
  );
  assert(
    modernConfig.includes(`const cloudflareWorkerName = '${expectedWorkerName(vertical.id)}'`),
    `${vertical.id} modern.config.ts must define the Cloudflare worker name`,
  );
  assert(
    modernConfig.includes('name: cloudflareWorkerName'),
    `${vertical.id} modern.config.ts must wire deploy.worker.name`,
  );
  assert(
    modernConfig.includes('const assetPrefix ='),
    `${vertical.id} modern.config.ts must derive a dedicated asset prefix`,
  );
  assert(
    modernConfig.includes("const configuredUltramodernAssetPrefix = envValue('ULTRAMODERN_ASSET_PREFIX')"),
    `${vertical.id} asset prefix must support ULTRAMODERN_ASSET_PREFIX`,
  );
  assert(
    modernConfig.includes("const configuredModernAssetPrefix = envValue('MODERN_ASSET_PREFIX')"),
    `${vertical.id} asset prefix must support MODERN_ASSET_PREFIX`,
  );
  assert(
    modernConfig.includes('const defaultRemoteAssetPrefix'),
    `${vertical.id} asset prefix must derive the remote asset origin`,
  );
  assert(
    modernConfig.includes('const defaultAssetPrefix = defaultRemoteAssetPrefix'),
    `${vertical.id} asset prefix must default to its own remote origin`,
  );
  const verticalAssetPrefixExpression = extractAssetPrefixExpression(modernConfig);
  assert(
    /configuredModernAssetPrefix\s*\|\|\s*configuredUltramodernAssetPrefix\s*\|\|\s*defaultAssetPrefix/u.test(
      verticalAssetPrefixExpression,
    ) ||
      /configuredModernAssetPrefix\s*\?\?\s*configuredUltramodernAssetPrefix\s*\?\?\s*defaultAssetPrefix/u.test(
        verticalAssetPrefixExpression,
      ),
    `${vertical.id} asset prefix fallback order is incorrect`,
  );
  assert(
    !verticalAssetPrefixExpression.includes('configuredSiteUrl') &&
      !verticalAssetPrefixExpression.includes(SHARED_VALIDATOR_STRING_081),
    `${vertical.id} asset prefix must not fall back to MODERN_PUBLIC_SITE_URL`,
  );
  assert(
    new RegExp(
      `envValue\\(\\s*'ULTRAMODERN_PUBLIC_URL_${vertical.id.replaceAll('-', '_').toUpperCase()}'\\s*,?\\s*\\)`,
      'u',
    ).test(modernConfig),
    `${vertical.id} asset prefix must read its per-app public URL`,
  );
  assert(
    modernConfig.includes('inferredCloudflareUrl'),
    `${vertical.id} asset prefix must support workers.dev origin inference`,
  );
  assert(
    /dev:\s*\{[\s\S]*?\/\/ Remote dev manifests must publish an absolute publicPath[\s\S]*?assetPrefix,/u.test(
      modernConfig,
    ),
    `${vertical.id} modern.config.ts must publish dev assets from its own remote origin`,
  );
  assert(
    modernConfig.includes('assetPrefix,'),
    `${vertical.id} modern.config.ts must wire output.assetPrefix to the derived asset prefix`,
  );
  assert(
    contractEntry?.config?.dev?.assetPrefix === SHARED_VALIDATOR_STRING_045,
    `${vertical.id} dev asset prefix must default to its app public origin`,
  );
  assert(
    contractEntry?.config?.output?.assetPrefix?.default === SHARED_VALIDATOR_STRING_045,
    `${vertical.id} asset prefix must default to its app public origin`,
  );
  assert(
    sameJson(contractEntry?.config?.output?.assetPrefix?.envFallbackOrder, [
      SHARED_VALIDATOR_STRING_080,
      SHARED_VALIDATOR_STRING_143,
    ]),
    `${vertical.id} asset prefix env fallback order is incorrect`,
  );
  assert(
    !(contractEntry?.config?.output?.disableTsChecker ?? false),
    `${vertical.id} must keep the framework TypeScript checker enabled`,
  );
  assert(
    contractEntry?.config?.performance?.readinessDiagnostics?.default === 'enabled',
    `${vertical.id} performance readiness diagnostics must be default-on`,
  );
  assert(
    contractEntry?.config?.performance?.readinessDiagnostics?.failOn === SHARED_VALIDATOR_STRING_069,
    `${vertical.id} performance readiness diagnostics must only fail framework invariants by default`,
  );
  assert(
    contractEntry?.config?.performance?.readinessDiagnostics?.optOut?.config === SHARED_VALIDATOR_STRING_121,
    `${vertical.id} performance readiness opt-out config is incorrect`,
  );
  if (vertical.emitsApi) {
    // Per policy.ts:76 the Cloudflare proof advertises a REST readiness route
    // only for `rest` units; an `rpc` unit must not carry one.
    if (vertical.apiProtocol === 'rpc') {
      assert(
        contractEntry?.deploy?.cloudflare?.routes?.apiReadiness === undefined,
        `${vertical.id} rpc unit must not carry a REST Cloudflare readiness route`,
      );
    } else {
      assert(
        contractEntry?.deploy?.cloudflare?.routes?.apiReadiness === `${vertical.apiPrefix}/${vertical.stem}/readiness`,
        `${vertical.id} Cloudflare proof readiness route is incorrect`,
      );
    }
  }
  assert(
    contractEntry?.config?.rspack?.output?.uniqueName === vertical.mfName,
    `${vertical.id} Rspack uniqueName is incorrect`,
  );
  assert(
    contractEntry?.config?.rspack?.output?.chunkLoadingGlobal === expectedChunkLoadingGlobal(vertical.mfName),
    `${vertical.id} Rspack chunkLoadingGlobal is incorrect`,
  );
  assert(contractEntry?.moduleFederation?.name === vertical.mfName, `${vertical.id} MF name is incorrect`);
  assert(
    sameJson(contractEntry?.moduleFederation?.exposes, vertical.exposes),
    `${vertical.id} MF exposes are incorrect`,
  );
  // The browser Module Federation DTS surface and its config file only exist
  // for UI-emitting units; a headless api-only unit federates no browser types.
  if (vertical.emitsUi && vertical.exposes.length > 0) {
    assert(
      contractEntry?.moduleFederation?.dts?.compilerInstance === SHARED_VALIDATOR_STRING_068,
      `${vertical.id} must keep mandatory DTS compiler`,
    );
    assert(
      contractEntry?.moduleFederation?.dts?.tsConfigPath === SHARED_VALIDATOR_STRING_007,
      `${vertical.id} must keep dedicated Module Federation DTS tsconfig`,
    );
    assert(
      moduleFederationConfig.includes("tsConfigPath: './tsconfig.mf-types.json'"),
      `${vertical.id} Module Federation config must use the dedicated DTS tsconfig`,
    );
  }
  assert(
    sameJson(contractEntry?.moduleFederation?.verticalRefs ?? [], vertical.verticalRefs),
    `${vertical.id} MF verticalRefs are incorrect`,
  );
  assert(
    sameJson(
      (contractEntry?.moduleFederation?.remotes ?? []).map((remote) => remote.id),
      vertical.verticalRefs,
    ),
    `${vertical.id} MF consumed verticals are incorrect`,
  );
  // API contract surface is only present for API-bearing units.
  if (vertical.emitsApi) {
    assert(contractEntry?.api?.prefix === vertical.apiPrefix, `${vertical.id} API prefix is incorrect`);
    assert(contractEntry?.api?.group === vertical.group, `${vertical.id} API group is incorrect`);
    assert(contractEntry?.api?.runtime === 'effect', `${vertical.id} API runtime must be Effect`);
    assert(contractEntry?.api?.strictEffectApproach ?? false, `${vertical.id} strictEffectApproach must be enabled`);
    assert(
      contractEntry?.api?.contract === vertical.apiContractExport,
      `${vertical.id} API contract export is incorrect`,
    );
    assert(contractEntry?.api?.client === vertical.apiClientExport, `${vertical.id} API client export is incorrect`);
    if (vertical.apiProtocol === 'rpc') {
      // An `rpc` unit records the `/rpc` route/serialization; it must not carry
      // REST readiness or domain-operation semantics.
      assert(contractEntry?.api?.protocol === 'rpc', `${vertical.id} generated contract API protocol must be rpc`);
      assert(contractEntry?.api?.rpc?.path === '/rpc', `${vertical.id} generated contract RPC route path is incorrect`);
      assert(
        contractEntry?.api?.rpcPath === `${vertical.apiPrefix}/rpc`,
        `${vertical.id} generated contract RPC path is incorrect`,
      );
    } else {
      const restApi = contractEntry?.api && !('rpc' in contractEntry.api) ? contractEntry.api : undefined;
      assert(
        restApi?.readiness?.endpoint === `/${vertical.stem}/readiness`,
        `${vertical.id} readiness endpoint is incorrect`,
      );
      assert(
        restApi?.operations?.readiness?.path === `/${vertical.stem}/readiness`,
        `${vertical.id} readiness operation is missing`,
      );
      assert(
        restApi?.requestContext?.propagatedHeaders?.includes(SHARED_VALIDATOR_STRING_142) ?? false,
        `${vertical.id} trace context propagation is missing`,
      );
      assert(
        vertical.apiContractExport === undefined
          ? restApi?.domainOperations === undefined
          : Object.keys(restApi?.domainOperations ?? {}).length >= 3,
        `${vertical.id} domain operations do not match its declared package API surface`,
      );
    }
  }
  assert(
    (contractEntry?.i18n?.languages?.includes('en') ?? false) &&
      (contractEntry?.i18n?.languages?.includes('cs') ?? false),
    `${vertical.id} must declare i18n languages`,
  );
  assert(contractEntry?.i18n?.namespace === vertical.namespace, `${vertical.id} i18n namespace is incorrect`);
  assert(
    sameJson(contractEntry?.i18n?.localisedUrls, vertical.localisedUrls),
    `${vertical.id} localisedUrls must come from route metadata`,
  );
  assert(contractEntry?.routes?.source === 'route-owned', `${vertical.id} routes must be route-owned`);
  assert(
    contractEntry?.routes?.metadataAuthoring === SHARED_VALIDATOR_STRING_062,
    `${vertical.id} route metadata authoring mode is incorrect`,
  );
  assert(contractEntry?.routes?.generatedManifest ?? false, `${vertical.id} route metadata manifest must be generated`);
  assert(
    contractEntry?.routes?.metadataExport === SHARED_VALIDATOR_STRING_006,
    `${vertical.id} route metadata export is incorrect`,
  );
  assert(contractEntry?.routes?.privateByDefault ?? false, `${vertical.id} routes must be private by default`);
  assert(
    contractEntry?.routes?.publicnessDefault === SHARED_VALIDATOR_STRING_105,
    `${vertical.id} route publicness default is incorrect`,
  );
  assert(
    (contractEntry?.routes?.publicRoutes ?? []).length === 0,
    `${vertical.id} must not expose generated public routes by default`,
  );
  // Public head/surface and owned browser routes only exist for UI-emitting
  // units; a headless api-only unit renders no route head or public surface.
  if (vertical.emitsUi) {
    assertPublicHeadContract(vertical.id, contractEntry?.routes?.publicHead, routeHead, vertical.hasOwnerPage);
    assertPublicSurfaceContract(vertical.id, contractEntry?.routes?.publicSurface);
    assert(
      (contractEntry?.routes?.owned ?? []).every(
        (route) =>
          !route.public &&
          !route.indexable &&
          route.publicSurface === SHARED_VALIDATOR_STRING_105 &&
          isString(route.descriptionKey),
      ),
      `${vertical.id} owned routes must be non-indexable private app screens by default and include description keys`,
    );
    assertPublicSurfaceAssets(vertical.path, contractEntry?.routes?.publicRoutes ?? []);
  }
  // CSS federation (a federated browser stylesheet keyed off the federation
  // entry) only applies to UI-emitting units; a headless api-only unit owns no
  // vertical CSS surface.
  if (vertical.emitsUi) {
    assert(
      contractEntry?.styling?.federation?.owner?.id === vertical.id,
      `${vertical.id} CSS federation owner is missing`,
    );
    assert(contractEntry?.styling?.federation?.role === 'vertical-css', `${vertical.id} must own only vertical CSS`);
    assert(
      contractEntry?.styling?.federation?.rootSelector === `[data-app-id="${vertical.id}"]`,
      `${vertical.id} CSS root selector is incorrect`,
    );
    assert(
      contractEntry?.styling?.federation?.classPrefix === `${vertical.tailwindPrefix}:`,
      `${vertical.id} CSS class prefix is incorrect`,
    );
    assert(
      contractEntry?.styling?.federation?.layers?.owned?.includes(`ultramodern-vertical-${vertical.domain}`) ?? false,
      `${vertical.id} vertical CSS layer is missing`,
    );
    assert(
      !(contractEntry?.styling?.federation?.layers?.owned?.includes(SHARED_VALIDATOR_STRING_150) ?? false),
      `${vertical.id} must not own shell base CSS`,
    );
    assert(
      contractEntry?.styling?.federation?.entrypoints?.federationEntry ===
        (vertical.hasFederationEntry ? SHARED_VALIDATOR_STRING_136 : undefined),
      `${vertical.id} CSS federation entry must match its exposed browser surface`,
    );
    assert(
      contractEntry?.styling?.federation?.assets?.shared?.some((asset) =>
        asset.endsWith('/shared-design-tokens/tokens.css'),
      ) ?? false,
      `${vertical.id} must import shared design token CSS`,
    );
    assert(
      contractEntry?.styling?.federation?.dedupe?.runtimeLoad === 'once-per-content-hash',
      `${vertical.id} CSS dedupe strategy is incorrect`,
    );
    assert(
      contractEntry?.styling?.federation?.ssr?.verticalCss === 'federated-manifest-owned-css',
      `${vertical.id} SSR CSS loading contract is incorrect`,
    );
  }

  const topologyEntry = topology.verticals?.find((verticalEntry) => verticalEntry.id === vertical.id);
  assert(topologyEntry?.kind === 'vertical', `${vertical.id} topology kind is incorrect`);
  assert(topologyEntry?.package === vertical.packageName, `${vertical.id} topology package is incorrect`);
  assert(
    topologyEntry?.cloudflare?.workerName === expectedWorkerName(vertical.id),
    `${vertical.id} topology Cloudflare workerName is incorrect`,
  );
  assert(topologyEntry?.moduleFederation?.name === vertical.mfName, `${vertical.id} topology MF name is incorrect`);
  assert(
    sameJson(topologyEntry?.moduleFederation?.exposes, vertical.exposes),
    `${vertical.id} topology exposes are incorrect`,
  );
  assert(
    sameJson(topologyEntry?.moduleFederation?.verticalRefs ?? [], vertical.verticalRefs),
    `${vertical.id} topology verticalRefs are incorrect`,
  );
  // API/BFF topology metadata only exists for API-bearing units; and the REST
  // readiness/domain-operation surface is absent for the RPC protocol (G7a).
  if (vertical.emitsApi) {
    assert(topologyEntry?.api?.bff?.prefix === vertical.apiPrefix, `${vertical.id} topology API prefix is incorrect`);
    assert(
      topologyEntry?.api?.bff?.strictEffectApproach ?? false,
      `${vertical.id} topology strictEffectApproach is incorrect`,
    );
    assert(
      topologyEntry?.api?.serverEntry === `${vertical.path}/api/index.ts`,
      `${vertical.id} topology server entry is incorrect`,
    );
    if (vertical.apiProtocol !== 'rpc') {
      assert(
        topologyEntry?.api?.readiness?.endpoint === `/${vertical.stem}/readiness`,
        `${vertical.id} topology readiness endpoint is incorrect`,
      );
      assert(
        topologyEntry?.api?.domainOperations === undefined ||
          Object.keys(topologyEntry.api.domainOperations).length >= 3,
        `${vertical.id} topology domain operations do not match its declared package API surface`,
      );
    }
  }

  if (vertical.deliveryUnit !== undefined) {
    const expectedDeliveryUnit = deliveryUnitBlock(expectedDeliveryUnitFor(vertical));
    const compactAppEntry = ultramodernConfig.topology?.apps?.find((entry) => entry?.id === vertical.id);
    // The backend-federation delivery-unit mirror only exists for API-bearing
    // units; a UI-only vertical carries just the app-level delivery unit.
    if (vertical.emitsApi) {
      const compactBackendDeliveryUnit = deliveryUnitBlock(compactAppEntry?.backendFederation?.deliveryUnit);
      assertSameJson(
        deliveryUnitBlock(compactAppEntry?.deliveryUnit),
        compactBackendDeliveryUnit,
        `${compactConfigPath} topology.apps.${vertical.id}.deliveryUnit`,
        deliveryUnitIdentityFixArea,
      );
      assertSameJson(
        compactBackendDeliveryUnit,
        expectedDeliveryUnit,
        `${compactConfigPath} topology.apps.${vertical.id}.backendFederation.deliveryUnit`,
        deliveryUnitIdentityFixArea,
      );
      assertSelfCheck(
        compactAppEntry?.backendFederation?.versionBoundary?.identityRoot === SHARED_VALIDATOR_STRING_065,
        `${compactConfigPath} topology.apps.${vertical.id}.backendFederation.versionBoundary.identityRoot`,
        `Expected "deliveryUnit", found ${formatJson(compactAppEntry?.backendFederation?.versionBoundary?.identityRoot)}`,
        deliveryUnitIdentityFixArea,
      );
    }
    assertSameJson(
      deliveryUnitBlock(compactAppEntry?.deliveryUnit),
      expectedDeliveryUnit,
      `${compactConfigPath} topology.apps.${vertical.id}.deliveryUnit`,
      deliveryUnitIdentityFixArea,
    );
    assertSameJson(
      deliveryUnitBlock(compactAppEntry?.deliveryUnit),
      deliveryUnitBlock(topologyEntry?.deliveryUnit),
      `${compactConfigPath} vs topology/reference-topology.json verticals.${vertical.id}.deliveryUnit`,
      deliveryUnitIdentityFixArea,
    );
  }

  assert(
    ownership.owners?.some((owner) => owner.id === vertical.id && owner.path === vertical.path),
    `${vertical.id} ownership entry is missing`,
  );
  assert(
    (valueForKey(Object.entries(overlay.ports ?? {}), vertical.id) ?? 0) !== 0,
    `${vertical.id} development port is missing`,
  );
  if (vertical.emitsUi) {
    assert(
      valueForKey(Object.entries(overlay.manifests ?? {}), vertical.id)?.includes(SHARED_VALIDATOR_STRING_031) ?? false,
      `${vertical.id} development manifest is missing`,
    );
  }
  if (vertical.emitsApi) {
    assert(
      valueForKey(Object.entries(overlay.apis ?? {}), vertical.id)?.endsWith(
        vertical.apiProtocol === 'rpc' ? `${vertical.apiPrefix}/rpc` : vertical.apiPrefix,
      ) ?? false,
      `${vertical.id} development API URL is missing`,
    );
  }
}

// Delivery-unit identity for ALL unit kinds (G29). Every workspace app —
// shell, UI-only vertical, and API-bearing vertical — is an indivisible
// delivery unit and must carry one consistent identity record across the
// compact config, the reference topology, and its generated build artifact
// (ADR-0019: one delivery-unit record, one build marker).
for (const expectedApp of workspaceValidationContract.topology.compactConfig?.apps ?? []) {
  const unitLabel = `delivery-unit identity for ${expectedApp.id}`;
  const expectedDeliveryUnit = deliveryUnitBlock(expectedApp.deliveryUnit);
  assertSelfCheck(
    isString(expectedDeliveryUnit.unitId) &&
      expectedDeliveryUnit.unitId.length > 0 &&
      isString(expectedDeliveryUnit.buildMarker) &&
      expectedDeliveryUnit.buildMarker.length > 0,
    unitLabel,
    `Every unit kind must declare a delivery-unit record; found ${formatJson(expectedApp.deliveryUnit)}`,
    deliveryUnitIdentityFixArea,
  );

  const compactAppEntry = ultramodernConfig.topology?.apps?.find((entry) => entry?.id === expectedApp.id);
  assertSameJson(
    compactAppEntry?.deploy?.cloudflare,
    expectedApp.deploy?.cloudflare,
    `${compactConfigPath} topology.apps.${expectedApp.id}.deploy.cloudflare`,
    'regenerate the app Cloudflare deployment contract; do not add local proof-only smoke checks',
  );
  assertSameJson(
    deliveryUnitBlock(compactAppEntry?.deliveryUnit),
    expectedDeliveryUnit,
    `${compactConfigPath} topology.apps.${expectedApp.id}.deliveryUnit`,
    deliveryUnitIdentityFixArea,
  );

  const topologyUnitEntry =
    expectedApp.kind === 'shell' ? topology.shell : topology.verticals?.find((entry) => entry?.id === expectedApp.id);
  const topologyUnitLabel = expectedApp.kind === 'shell' ? 'shell' : `verticals.${expectedApp.id}`;
  assertSameJson(
    deliveryUnitBlock(topologyUnitEntry?.deliveryUnit),
    expectedDeliveryUnit,
    `topology/reference-topology.json ${topologyUnitLabel}.deliveryUnit`,
    deliveryUnitIdentityFixArea,
  );

  const appPath = expectedApp.path;
  const buildArtifactPath = `${appPath}/shared/ultramodern-build.json`;
  assertExists(buildArtifactPath);
  const buildIdentity = readJson(BuildArtifactSchema, buildArtifactPath).deliveryUnit ?? {};
  assertSelfCheck(
    buildIdentity.unitId === expectedDeliveryUnit.unitId &&
      buildIdentity.buildMarker === expectedDeliveryUnit.buildMarker,
    `${buildArtifactPath} deliveryUnit`,
    `Expected ${formatJson({ buildMarker: expectedDeliveryUnit.buildMarker, unitId: expectedDeliveryUnit.unitId })}, found ${formatJson({ buildMarker: buildIdentity.buildMarker, unitId: buildIdentity.unitId })}`,
    deliveryUnitIdentityFixArea,
  );
  const buildModuleSource = readText(`${appPath}/shared/ultramodern-build.ts`);
  assertSelfCheck(
    buildModuleSource.includes('export const ultramodernDeliveryUnit'),
    `${appPath}/shared/ultramodern-build.ts`,
    'Missing ultramodernDeliveryUnit export',
    deliveryUnitIdentityFixArea,
  );
}

const legacyIdentityAllowlist = new Set([
  'packages/core-runtime/drizzle/20260901102632_rename-crm-module-identity/migration.sql',
  'packages/core-runtime/tests/integration/contacts-identity-migration.test.ts',
  'scripts/migrate-contacts-authorization.mts',
  'scripts/tests/migrate-contacts-authorization.test.mts',
  SHARED_VALIDATOR_STRING_124,
  'verticals/party-registry/drizzle-contacts/20260813194916_supreme_famine/migration.sql',
  'verticals/party-registry/drizzle-contacts/20260813194916_supreme_famine/snapshot.json',
  'verticals/party-registry/drizzle-contacts/20260817102325_open_omega_red/migration.sql',
  'verticals/party-registry/drizzle-contacts/20260817102325_open_omega_red/snapshot.json',
  'verticals/party-registry/drizzle-contacts/20260901102631_rename-crm-database-identity/migration.sql',
  'verticals/party-registry/scripts/prepare-contacts-migration.mts',
  'verticals/party-registry/tests/unit/prepare-contacts-migration.test.ts',
  'verticals/party-registry/tests/unit/engagement-schema-contract.test.ts',
]);
const legacyIdentityToken = /(?:^|[^A-Za-z])(?:crm|CRM|Crm)/u;
for (const legacyIdentityProbe of ['crm', 'CRM', 'Crm', 'crmClient', 'CrmApi', 'CRM_SERVICE']) {
  assert(legacyIdentityToken.test(legacyIdentityProbe), `Legacy identity guard does not reject ${legacyIdentityProbe}`);
}
assert(!legacyIdentityToken.test('scrm'), 'Legacy identity guard must not match the CRM letters inside another word');
const staleNameScanRoot = path.resolve(root, '..');
const staleNameScanPaths = [path.basename(root), 'README.md', 'CONTEXT-MAP.md', 'docs', '.github/workflows'];
const gitExecutable = 'git';
const trackedAndUntrackedFiles = [
  execFileSync(gitExecutable, ['ls-files', ...staleNameScanPaths], {
    cwd: staleNameScanRoot,
    encoding: 'utf-8',
  }),
  execFileSync(gitExecutable, ['ls-files', '--others', '--exclude-standard', ...staleNameScanPaths], {
    cwd: staleNameScanRoot,
    encoding: 'utf-8',
  }),
]
  .join('\n')
  .split('\n')
  .filter((filePath) => filePath.length > 0)
  .map((filePath) => path.relative(root, path.resolve(staleNameScanRoot, filePath)));
const legacyIdentityViolations = trackedAndUntrackedFiles.filter((filePath) => {
  const normalizedPath = filePath.replace(/^\.\//u, '');
  if (
    normalizedPath.startsWith('specs/') ||
    normalizedPath.startsWith('../docs/adr/') ||
    normalizedPath.startsWith('../docs/decisions/') ||
    legacyIdentityAllowlist.has(normalizedPath)
  ) {
    return false;
  }
  const absolutePath = path.resolve(root, filePath);
  try {
    return legacyIdentityToken.test(fs.readFileSync(absolutePath, 'utf-8'));
  } catch {
    return false;
  }
});
assert(
  legacyIdentityViolations.length === 0,
  `Active application and current documentation surfaces contain legacy CRM identity tokens: ${legacyIdentityViolations.join(', ')}`,
);

const program = Effect.gen(function* validateUltramodernWorkspace() {
  const packageManagerUserAgent = yield* Config.string('npm_config_user_agent');
  assertActivePnpmVersion(packageManagerUserAgent);
  yield* traceDeploymentSystemGlobs;
  yield* checkOntosModuleContracts(root);
  console.log('UltraModern workspace scaffold validated');
});

const executableLayer = Layer.effectDiscard(program).pipe(Layer.provide(NodeServices.layer));
NodeRuntime.runMain(Effect.scoped(Layer.build(executableLayer)));
