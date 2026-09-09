import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import {
  defineEffectBff,
  Effect,
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpEffect,
  HttpServerResponse,
  Layer,
  Schema,
} from '@modern-js/plugin-bff/effect-edge';
import { Cause, Clock, ConfigProvider, Predicate, Redacted } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';
import { SignJWT, exportJWK, generateKeyPair, generateSecret, importJWK } from 'jose';
import type { JWK } from 'jose';

import type { GatewayIssuerConfigValue } from '../../../apps/shell-super-app/api/auth/gateway-issuer-config.ts';
import {
  issueGatewayContextAssertion,
  makeGatewayIssuerLayer,
} from '../../../apps/shell-super-app/api/auth/gateway-issuer.ts';
import { defineAction } from '../../../packages/core-runtime/src/actions/definition.ts';
import { TrustedPrincipalContextSchema } from '../../../packages/core-runtime/src/actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../../../packages/core-runtime/src/actions/principal-context.ts';
import { GatewayAssertionRedemptionService } from '../../../packages/core-runtime/src/auth/gateway-assertion-redemption.ts';
import { defineSystemModuleEntrypoint } from '../../../packages/core-runtime/src/modules/module-entrypoint.ts';
import { makeActionTestHarness } from '../../../packages/core-runtime/src/testing/actions.ts';
import type { GatewayPrincipalVerifierLive } from '../../../packages/gateway-principal-verifier/src/server.ts';
import {
  GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS,
  GATEWAY_ASSERTION_TTL_SECONDS,
} from '../../../packages/shared-contracts/src/gateway-context.ts';
import type { bindActionHttpRunner as ActionHttpRunnerBinding } from '../../../verticals/party-registry/api/action-http-runner.ts';
import { hasValidGovernedHttpCompositionRoot } from '../../generated-governed-http-boundary.mts';
import {
  assertPublishedOutboxDependencyUsage,
  publishedOutboxContractExports,
} from '../../published-outbox-contracts.mts';
import { getHelpText, runScaffoldEffect, ScaffoldingError } from '../cli.mts';
import type { ScaffoldCommand } from '../cli.mts';
import type { JsonValue } from '../shared.mts';
import {
  GOVERNED_HTTP_API_ADDITION_SLOT_END,
  GOVERNED_HTTP_API_ADDITION_SLOT_START,
  GOVERNED_HTTP_HANDLER_LAYER_SLOT_END,
  GOVERNED_HTTP_HANDLER_LAYER_SLOT_START,
  GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_START,
  GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_END,
  GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START,
  GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_END,
  ScaffoldFailure,
  createScaffoldErrorTools,
  insertSortedSlot,
  readGeneratedSlotEntries,
} from '../shared.mts';
import { snapshotTree, write } from './fixture-files.mts';
import { linkFixtureDependencies } from './fixture-ownership.mts';

const expectFailure = <A, E, R>(self: Effect.Effect<A, E, R>, check: (cause: unknown) => void) =>
  Effect.matchCauseEffect(self, {
    onFailure: (cause) => Effect.sync(() => check(Cause.squash(cause))),
    onSuccess: () =>
      Effect.sync(() => {
        throw new Error('Expected operation to fail');
      }),
  });

class FirstScaffoldTestError extends Schema.TaggedError<FirstScaffoldTestError>()('FirstScaffoldTestError', {
  cause: Schema.optionalKey(Schema.Unknown),
  message: Schema.String,
}) {}

const firstScaffoldErrors = createScaffoldErrorTools(
  FirstScaffoldTestError,
  Schema.is(FirstScaffoldTestError),
  'first update failed',
);
const secondScaffoldErrors = createScaffoldErrorTools(
  ScaffoldFailure,
  Schema.is(ScaffoldFailure),
  'second update failed',
);

it.effect(
  'scaffold error tools preserve success and own failure identity',
  Effect.fn(function* ownScaffoldFailure() {
    const value = { unchanged: true };
    expect(yield* firstScaffoldErrors.trySync(() => value)).toBe(value);
    const own = firstScaffoldErrors.scaffoldError('own failure');
    const failure = yield* firstScaffoldErrors
      .trySync(() => {
        throw own;
      })
      .pipe(Effect.flip);
    expect(failure).toBe(own);
  }),
);

it('scaffold error tools omit undefined causes and retain defined causes', () => {
  expect(Object.hasOwn(firstScaffoldErrors.scaffoldError('absent'), 'cause')).toBe(false);
  const absentCause = firstScaffoldErrors.scaffoldError('absent').cause;
  expect(Object.hasOwn(firstScaffoldErrors.scaffoldError('undefined', absentCause), 'cause')).toBe(false);
  for (const cause of [null, false, 0, '', { detail: 'retained' }]) {
    const failure = firstScaffoldErrors.scaffoldError('defined', cause);
    expect(Object.hasOwn(failure, 'cause')).toBe(true);
    expect(failure.cause).toBe(cause);
  }
});

it.effect(
  'scaffold error tools normalize foreign errors without accepting another owner',
  Effect.fn(function* foreignScaffoldFailure() {
    const foreign = secondScaffoldErrors.scaffoldError('foreign owner');
    expect(Schema.is(FirstScaffoldTestError)(foreign)).toBe(false);
    expect(Schema.is(ScaffoldFailure)(foreign)).toBe(true);
    const emptyMessageError = new Error('initial');
    emptyMessageError.message = '';
    yield* Effect.gen(function* foreignScaffoldErrors() {
      for (const cause of [new Error('foreign error'), emptyMessageError, foreign]) {
        const failure = yield* firstScaffoldErrors
          .trySync(() => {
            throw cause;
          })
          .pipe(Effect.flip);
        expect(failure).not.toBe(cause);
        expect(Schema.is(FirstScaffoldTestError)(failure)).toBe(true);
        expect(Schema.is(ScaffoldFailure)(failure)).toBe(false);
        expect(failure.message).toBe(cause.message);
        expect(failure.cause).toBe(cause);
      }
    });
  }),
);

for (const [index, cause] of [undefined, null, 'thrown string', { message: 'not an Error' }].entries()) {
  it.effect(
    `scaffold error tools use owner fallback for non-error ${index}`,
    Effect.fn(function* nonErrorScaffoldFailure() {
      const operation = () => {
        const iterator = (function* thrownValue() {
          yield cause;
        })();
        iterator.next();
        return iterator.throw(cause);
      };
      const first = yield* firstScaffoldErrors.trySync(operation).pipe(Effect.flip);
      const second = yield* secondScaffoldErrors.trySync(operation).pipe(Effect.flip);
      expect(first.message).toBe('first update failed');
      expect(second.message).toBe('second update failed');
      for (const failure of [first, second]) {
        expect(failure.cause).toBe(cause);
        expect(Object.hasOwn(failure, 'cause')).toBe(cause !== undefined);
      }
    }),
  );
}

interface Fixture {
  readonly root: string;
}

const GeneratedPrincipalErrorTagSchema = Schema.Literals([
  'ActionPrincipalConfigurationError',
  'ActionPrincipalExpiredError',
  'ActionPrincipalInvalidError',
  'ActionPrincipalMissingError',
  'ActionPrincipalScopeError',
  'ActionPrincipalUnavailableError',
]);
type GeneratedPrincipalErrorTag = typeof GeneratedPrincipalErrorTagSchema.Type;

const isGeneratedPrincipalError = (tag: GeneratedPrincipalErrorTag) =>
  Schema.is(Schema.Struct({ _tag: Schema.Literal(tag) }));

const sharedContractsPackagePath = 'packages/shared-contracts';

const sharedContractsNodeModulePath = 'node_modules/@app/shared-contracts';

const partyGovernedContractPath = 'verticals/party-registry/shared/api.ts';

interface FixtureVertical {
  readonly appId: string;
  readonly mfBoundaryId: string;
  readonly moduleId: string;
  readonly namespace: string;
  readonly slug: string;
}

interface GeneratedPrincipalEnvironment {
  readonly ONTOS_GATEWAY_ISSUER?: string;
  readonly ONTOS_GATEWAY_PUBLIC_JWKS?: string;
}

interface GeneratedPrincipalModule {
  readonly ActionPrincipalVerifierLive: typeof GatewayPrincipalVerifierLive;
  readonly verifyActionPrincipal: (
    authorization: string | undefined,
    options: {
      readonly currentTimeSeconds: Effect.Effect<number>;
      readonly environment: GeneratedPrincipalEnvironment;
      readonly redemption: { readonly consume: () => Effect.Effect<void> };
    },
  ) => Effect.Effect<TrustedPrincipalContext, { readonly _tag: GeneratedPrincipalErrorTag }>;
}

interface GeneratedActionHttpRunnerModule {
  readonly bindActionHttpRunner: typeof ActionHttpRunnerBinding;
}

interface GeneratedOperationGatewayModule {
  readonly makeOperationGateway: (
    acquire: (payload: { readonly audience: string }) => Effect.Effect<{ readonly token: string }>,
  ) => {
    readonly invoke: <Success>(attempt: (authorization: string) => Effect.Effect<Success>) => Effect.Effect<Success>;
  };
}

const GeneratedPrincipalModuleSchema = Schema.Struct({
  ActionPrincipalVerifierLive: Schema.declare<GeneratedPrincipalModule['ActionPrincipalVerifierLive']>(
    (value): value is GeneratedPrincipalModule['ActionPrincipalVerifierLive'] => Predicate.isObject(value),
  ),
  verifyActionPrincipal: Schema.declare<GeneratedPrincipalModule['verifyActionPrincipal']>(
    (value): value is GeneratedPrincipalModule['verifyActionPrincipal'] => Predicate.isFunction(value),
  ),
});

const GeneratedActionHttpRunnerModuleSchema = Schema.Struct({
  bindActionHttpRunner: Schema.declare<GeneratedActionHttpRunnerModule['bindActionHttpRunner']>(
    (value): value is GeneratedActionHttpRunnerModule['bindActionHttpRunner'] => Predicate.isFunction(value),
  ),
});

const GeneratedOperationGatewayModuleSchema = Schema.Struct({
  makeOperationGateway: Schema.declare<GeneratedOperationGatewayModule['makeOperationGateway']>(
    (value): value is GeneratedOperationGatewayModule['makeOperationGateway'] => Predicate.isFunction(value),
  ),
});

const StringRecordSchema = Schema.Record(Schema.String, Schema.String);
const FixturePackageSchema = Schema.Struct({
  dependencies: StringRecordSchema,
  exports: StringRecordSchema,
  modernjs: Schema.Record(Schema.String, Schema.Json),
  scripts: StringRecordSchema,
});
const EsbuildMetafileSchema = Schema.Struct({
  inputs: Schema.Record(
    Schema.String,
    Schema.Struct({
      bytes: Schema.Number,
    }),
  ),
});
const RetryableProblemSchema = Schema.Struct({
  retryable: Schema.optional(Schema.Boolean),
});
const problemFields = {
  detail: Schema.String,
  status: Schema.Finite,
  title: Schema.String,
  type: Schema.String,
};
const asProblemDetails = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});
const ActionAuthenticationProblemSchema = Schema.TaggedStruct('ActionAuthenticationProblem', problemFields).pipe(
  asProblemDetails,
  HttpApiSchema.status(401),
);
const ActionVerificationUnavailableProblemSchema = Schema.TaggedStruct('ActionVerificationUnavailableProblem', {
  ...problemFields,
  retryable: Schema.Literal(true),
}).pipe(asProblemDetails, HttpApiSchema.status(503));
type EndpointProblem =
  | typeof ActionAuthenticationProblemSchema.Type
  | typeof ActionVerificationUnavailableProblemSchema.Type;
const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);

const actionAuthenticationProblem = (): typeof ActionAuthenticationProblemSchema.Type => ({
  _tag: 'ActionAuthenticationProblem',
  detail: 'A valid Bearer assertion is required.',
  status: 401,
  title: 'Action authentication required',
  type: 'https://ontos.dev/problems/action-authentication-required',
});

const actionVerificationUnavailableProblem = (): typeof ActionVerificationUnavailableProblemSchema.Type => ({
  _tag: 'ActionVerificationUnavailableProblem',
  detail: 'Action identity verification is temporarily unavailable.',
  retryable: true,
  status: 503,
  title: 'Action verification unavailable',
  type: 'https://ontos.dev/problems/action-verification-unavailable',
});

const failActionAuthentication = () =>
  bearerChallenge.pipe(Effect.andThen(Effect.fail<EndpointProblem>(actionAuthenticationProblem())));
const failActionVerificationUnavailable = () => Effect.fail<EndpointProblem>(actionVerificationUnavailableProblem());
const generatedPrincipalErrorHandlers = {
  ActionPrincipalConfigurationError: failActionVerificationUnavailable,
  ActionPrincipalExpiredError: failActionAuthentication,
  ActionPrincipalInvalidError: failActionAuthentication,
  ActionPrincipalMissingError: failActionAuthentication,
  ActionPrincipalScopeError: failActionAuthentication,
  ActionPrincipalUnavailableError: failActionVerificationUnavailable,
};

const GeneratedBindingResultSchema = Schema.Struct({
  accepted: Schema.Literal(true),
});

const generatedBindingAction = defineAction(
  {
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.test.generated-action-http.access.v1',
    },
    actionKey: 'core.test.generated-action-http',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineSystemModuleEntrypoint({
      access: 'write',
      authorization: {
        kind: 'action_execution',
        provisioning: 'tenant_membership_default',
      },
      entrypointKey: 'core.test.generated-action-http',
      moduleKey: 'core.shell',
      role: 'action',
    }),
    idempotency: 'optional',
    legalEntityScope: 'optional',
    owningModuleKey: 'core.shell',
    payloadSchema: Schema.Struct({}),
    policies: [],
    resultSchema: GeneratedBindingResultSchema,
    schemaVersion: '1',
  },
  () => Effect.succeed({ accepted: true as const }),
);

const FixtureTsconfigSchema = Schema.Struct({
  references: Schema.Array(Schema.Struct({ path: Schema.String })),
});
const InventoryLocaleSchema = Schema.Struct({
  inventory: Schema.Struct({
    existing: Schema.optional(Schema.String),
    pages: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  }),
});

const decodeFixturePackage = (source: string) =>
  Schema.decodeUnknownEffect(FixturePackageSchema, {
    onExcessProperty: 'preserve',
  })(JSON.parse(source));
const decodeInventoryLocale = (source: string) =>
  Schema.decodeUnknownEffect(InventoryLocaleSchema, {
    onExcessProperty: 'preserve',
  })(JSON.parse(source));

const inventorySlug = 'inventory-stock';
const shellAppId = 'shell-super-app';
const fixtureGatewayIssuer = 'https://shell.example.test';
const preservedFixtureValue = 'preserve-me';
const topologyFile = 'topology/reference-topology.json';
const inventoryPackageName = `@app/${inventorySlug}`;
const workspaceVersion = 'workspace:*';
const fixtureGatewayJti = '60000000-0000-4000-8000-000000000001';
const actionInvokeUrl = 'https://inventory.example.test/actions/invoke';
const generatedOutboxContractPath = './shared/outbox/orders-created.ts';
const workerStartScript = 'node --experimental-strip-types ./src/worker-host/main.ts';
const workerRegistryEntry = 'ordersCreatedProjectorWorker,';
const pagePlaceholder = 'This page is ready for implementation.';
const purchasingOrdersUrl = '/purchasing/orders';
const customerDetailUrl = '/inventory/customers/:id';
const customerEditUrl = '/inventory/customers/:id/edit';
const scaffoldCommand = {
  actionService: 'action-service',
  externalHttpAdapter: 'external-http-adapter',
  microverticalActionBoundary: 'microvertical-action-boundary',
  microverticalPage: 'microvertical-page',
  moduleApi: 'module-api',
  outboxMessage: 'outbox-message',
  outboxWorker: 'outbox-worker',
  publicComponent: 'public-component',
  searchProvider: 'search-provider',
  searchProviderAccess: 'search-provider-access',
} as const;
const scaffoldFlag = {
  accessFiltering: '--access-filtering',
  authorization: '--authorization',
  legalEntityScope: '--legal-entity-scope',
  operation: '--operation',
  producer: '--producer',
  provider: '--provider',
  requestFilters: '--request-filters',
  resource: '--resource',
  vertical: '--vertical',
} as const;
const fixtureName = {
  action: 'create-order',
  actionModule: 'core.modules',
  customerEditPage: 'customer-edit',
  inventoryItems: 'inventory-items',
  ordersCreated: 'orders.created',
  ordersCreatedLogger: 'orders-created-logger',
  ordersLogger: 'orders-logger',
  ordersShipped: 'orders.shipped',
  policy: 'tenant-active',
  purchaseOrdersPage: 'purchase-orders',
  resourceDetail: 'resource-detail',
  stockLevels: 'stock-levels',
} as const;
const rootPackageFile = 'package.json';
const coreRuntimeIndexFile = 'packages/core-runtime/src/index.ts';
const coreActionCatalogFile = 'packages/core-runtime/src/modules/actions/catalog.ts';
const shellSentinelFile = 'apps/shell-super-app/src/sentinel.ts';
const shellVerticalClientsFile = 'apps/shell-super-app/src/api/vertical-clients.ts';
const inventoryManifestFile = 'verticals/inventory-stock/vertical.manifest.ts';
const inventoryRegistrationFile = 'verticals/inventory-stock/vertical.registration.ts';
const inventoryFederationConfigFile = 'verticals/inventory-stock/module-federation.config.ts';
const inventorySearchProviderFile = 'verticals/inventory-stock/src/search/inventory-items.provider.ts';
const inventorySearchContractFile = 'verticals/inventory-stock/shared/apis/inventory-items-search.ts';

const inventoryModuleApiContractFile = 'verticals/inventory-stock/shared/apis/resource-detail.ts';

const inventoryModuleApiReadFile = 'verticals/inventory-stock/src/api/resource-detail.read.ts';

const inventoryModuleApiClientFile = 'verticals/inventory-stock/src/api/resource-detail-client.ts';

const inventoryModuleApiServerFile = 'verticals/inventory-stock/api/resource-detail-read-server.ts';

const inventorySearchClientFile = 'verticals/inventory-stock/src/api/inventory-items-search-client.ts';

const inventorySearchServerFile = 'verticals/inventory-stock/api/inventory-items-search-server.ts';

const inventoryReportProviderFile = 'verticals/inventory-stock/src/reports/stock-levels.provider.ts';

const inventoryReportContractFile = 'verticals/inventory-stock/shared/apis/stock-levels-report.ts';

const inventoryReportClientFile = 'verticals/inventory-stock/src/api/stock-levels-report-client.ts';

const inventoryReportServerFile = 'verticals/inventory-stock/api/stock-levels-report-server.ts';

const inventoryActionPrincipalFile = 'verticals/inventory-stock/api/auth/action-principal.ts';

const inventoryActionHttpRunnerFile = 'verticals/inventory-stock/api/action-http-runner.ts';

const inventoryActionGatewayFile = 'verticals/inventory-stock/src/api/action-gateway.ts';
const inventoryPackageFile = 'verticals/inventory-stock/package.json';
const inventoryActionFile = 'verticals/inventory-stock/src/actions/create-order.action.ts';
const inventoryOutboxContractFile = 'verticals/inventory-stock/shared/outbox/orders-created.ts';
const billingApiIndexFile = 'verticals/billing/api/index.ts';
const billingWorkersIndexFile = 'verticals/billing/src/workers/index.ts';
const inventoryTsconfigFile = 'verticals/inventory-stock/tsconfig.json';
const inventoryEnglishLocaleFile = 'verticals/inventory-stock/locales/en/inventory.json';
const inventoryOrdersRouteFile = 'verticals/inventory-stock/src/routes/[lang]/orders/page.tsx';
const effectNodeModulePath = 'node_modules/effect';
const pluginBffNodeModulePath = 'node_modules/@modern-js/plugin-bff';

const inventoryVertical: FixtureVertical = {
  appId: inventorySlug,
  mfBoundaryId: 'verticalInventoryStock',
  moduleId: 'inventory.stock',
  namespace: 'inventory',
  slug: inventorySlug,
};

const billingVertical: FixtureVertical = {
  appId: 'billing',
  mfBoundaryId: 'verticalBilling',
  moduleId: 'billing.core',
  namespace: 'billing',
  slug: 'billing',
};

const hrVertical: FixtureVertical = {
  appId: 'hr',
  mfBoundaryId: 'verticalHr',
  moduleId: 'hr.core',
  namespace: 'hr',
  slug: 'hr',
};

const contactsVertical: FixtureVertical = {
  appId: 'contacts',
  mfBoundaryId: 'verticalContacts',
  moduleId: 'contacts.core',
  namespace: 'contacts',
  slug: 'contacts',
};

const json = (value: JsonValue): string => `${JSON.stringify(value, null, 2)}\n`;

const inventoryHandlerRootFile = 'verticals/inventory-stock/api/index.ts';

const appRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(import.meta.url);
const createEntry = require.resolve('@modern-js/ultramodern-create');
const esbuildPath = require.resolve('esbuild/bin/esbuild', {
  paths: [path.dirname(createEntry)],
});
const oxfmtPath = path.join(appRoot, 'node_modules', '.bin', 'oxfmt');
const tscPath = path.join(appRoot, 'node_modules', '.bin', 'tsc');

const makeGatewayKey = (
  kid: string,
): Effect.Effect<
  {
    configuration: GatewayIssuerConfigValue;
    publicJwk: JWK;
  },
  unknown
> =>
  Effect.gen(function* scenario1() {
    const pair = yield* Effect.promise(() => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
    const privateJwk = yield* Effect.promise(() => exportJWK(pair.privateKey));
    const publicJwk = yield* Effect.promise(() => exportJWK(pair.publicKey));
    return {
      configuration: {
        issuer: fixtureGatewayIssuer,
        privateJwk: {
          alg: 'EdDSA',
          crv: 'Ed25519',
          d: privateJwk.d ?? '',
          kid,
          kty: 'OKP',
          use: 'sig',
          x: privateJwk.x ?? '',
        },
      },
      publicJwk: { ...publicJwk, alg: 'EdDSA', kid, use: 'sig' },
    };
  });

const createVertical = (root: string, vertical: FixtureVertical): Effect.Effect<void, unknown> =>
  Effect.gen(function* mergedScenario15() {
    yield* write(root, `verticals/${vertical.slug}/module-federation.config.ts`, 'export default { exposes: {} };\n');
    yield* write(
      root,
      `verticals/${vertical.slug}/tsconfig.json`,
      json({
        compilerOptions: { composite: true },
        include: ['src', 'shared'],
        references: [],
      }),
    );
    yield* write(
      root,
      `verticals/${vertical.slug}/package.json`,
      json({
        dependencies: { zeta: '1.0.0' },
        exports: {
          './locales/cs': `./locales/cs/${vertical.namespace}.json`,
          './locales/en': `./locales/en/${vertical.namespace}.json`,
        },
        modernjs: {
          apiRuntime: 'effect',
          appId: vertical.appId,
          preset: 'presetUltramodern',
          role: 'module-federation-remote',
          topology: '../../topology/reference-topology.json',
        },
        name: `@app/${vertical.slug}`,
        private: true,
        scripts: {
          build: 'modern build && MODERNJS_DEPLOY=node modern deploy --skip-build',
          'cloudflare:build':
            'MODERNJS_DEPLOY=cloudflare modern build && MODERNJS_DEPLOY=cloudflare modern deploy --skip-build',
          existing: preservedFixtureValue,
        },
        version: '0.1.0',
      }),
    );
    yield* write(
      root,
      `verticals/${vertical.slug}/api/index.ts`,
      `import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import type { EffectRuntimeLayer } from '@modern-js/plugin-bff/effect-edge';
import { fixtureApi } from '../shared/api.ts';

const fixtureLayer = HttpApiBuilder.group(fixtureApi, 'fixture', (handlers) =>
  handlers.handle('readiness', () => Effect.succeed({ ok: true as const })),
);
const layer = HttpApiBuilder.layer(fixtureApi).pipe(
  Layer.provide(fixtureLayer),
) satisfies EffectRuntimeLayer;

export default defineEffectBff({ api: fixtureApi, layer });
`,
    );
    yield* write(
      root,
      `verticals/${vertical.slug}/shared/api.ts`,
      `import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

export const fixtureApi = HttpApi.make('FixtureApi').add(
  HttpApiGroup.make('fixture').add(
    HttpApiEndpoint.get('readiness', '/fixture/readiness', {
      success: Schema.Struct({ ok: Schema.Literal(true) }),
    }),
  ),
);
`,
    );
    yield* Effect.all(
      ['cs', 'en'].map(
        Effect.fn(function* mergedScenario14(locale) {
          return yield* write(
            root,
            `verticals/${vertical.slug}/locales/${locale}/${vertical.namespace}.json`,
            json({
              [vertical.namespace]: {
                existing: `${locale}-preserved`,
              },
            }),
          );
        }),
      ),
      { concurrency: 'unbounded' },
    );
    const resourcesName = `${vertical.slug
      .split('-')
      .map((segment, index) => (index === 0 ? segment : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`))
      .join('')}I18nResources`;
    yield* write(
      root,
      `verticals/${vertical.slug}/src/i18n/resources.ts`,
      `import csResource from '../../locales/cs/${vertical.namespace}.json';
import enResource from '../../locales/en/${vertical.namespace}.json';

type LocaleResource = string | { readonly [key: string]: LocaleResource };

const flattenLocaleResource = (resource: LocaleResource, prefix = ''): Record<string, string> => {
  if (typeof resource === 'string') {
    return prefix.length > 0 ? { [prefix]: resource } : {};
  }

  return Object.fromEntries(
    Object.entries(resource).flatMap(([key, value]) => {
      const nextKey = prefix.length > 0 ? \`\${prefix}.\${key}\` : key;
      return typeof value === 'string'
        ? [[nextKey, value]]
        : Object.entries(flattenLocaleResource(value, nextKey));
    }),
  );
};

export const ${resourcesName} = {
  cs: { ${vertical.namespace}: flattenLocaleResource(csResource) },
  en: { ${vertical.namespace}: flattenLocaleResource(enResource) },
} as const;
`,
    );
    yield* write(
      root,
      `verticals/${vertical.slug}/src/routes/ultramodern-route-head.tsx`,
      'export const UltramodernRouteHead = () => null;\n',
    );
  });

const createFixture = (): Effect.Effect<Fixture, unknown> =>
  Effect.gen(function* scenario5() {
    const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'ontos-scaffolding-')));
    yield* write(root, rootPackageFile, json({ name: 'fixture', private: true }));
    yield* write(
      root,
      coreRuntimeIndexFile,
      `export const existingCoreSurface = true;\n\n// <generated-core-action-exports>\n// </generated-core-action-exports>\n\n// <generated-global-policy-exports>\n// </generated-global-policy-exports>\n`,
    );
    yield* write(
      root,
      coreActionCatalogFile,
      `export const existingCatalogSurface = true;

// <generated-core-action-catalog-imports>
// </generated-core-action-catalog-imports>

export const coreActionCatalog = [
  // <generated-core-action-catalog-values>
  // </generated-core-action-catalog-values>
];
`,
    );
    yield* write(root, shellSentinelFile, 'export const shell = true;\n');
    yield* write(
      root,
      shellVerticalClientsFile,
      `export const ultramodernVerticalClients = [
  // @ontos-codegen-start shell-page-clients
  // @ontos-codegen-end shell-page-clients
] as const;
`,
    );
    yield* createVertical(root, inventoryVertical);
    yield* createVertical(root, billingVertical);
    yield* createVertical(root, hrVertical);
    yield* createVertical(root, contactsVertical);
    yield* write(
      root,
      topologyFile,
      json({
        schemaVersion: 1,
        verticals: [inventoryVertical, billingVertical, hrVertical, contactsVertical].map((vertical) => ({
          domain: vertical.namespace,
          id: vertical.appId,
          kind: 'vertical',
          moduleFederation: {
            name: vertical.mfBoundaryId,
            role: 'remote',
          },
          package: `@app/${vertical.slug}`,
          path: `verticals/${vertical.slug}`,
        })),
      }),
    );
    yield* Effect.all(
      [inventoryVertical, billingVertical, hrVertical, contactsVertical].map(
        Effect.fn(function* scenario6(vertical) {
          return yield* runScaffoldEffect(
            'module-contract',
            [scaffoldFlag.vertical, vertical.slug, '--module', vertical.moduleId],
            {
              workspaceRoot: root,
            },
          ).pipe(Effect.provide(NodeServices.layer));
        }),
      ),
      { concurrency: 'unbounded' },
    );
    return { root };
  });

const withFixture = (
  run: (fixture: Fixture) => Effect.Effect<void, unknown, Scope.Scope>,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* scenario7() {
    const fixture = yield* createFixture();
    yield* Effect.scoped(run(fixture)).pipe(
      Effect.ensuring(Effect.promise(() => rm(fixture.root, { force: true, recursive: true }))),
    );
  });

const readFixtureFile = (root: string, relativePath: string): Effect.Effect<string, unknown> =>
  Effect.gen(function* scenario11() {
    return yield* Effect.promise(() => readFile(path.join(root, relativePath), 'utf-8'));
  });

const contextPermissionCommands = new Set<ScaffoldCommand>([
  scaffoldCommand.microverticalPage,
  scaffoldCommand.moduleApi,
  scaffoldCommand.publicComponent,
  'report',
  scaffoldCommand.searchProvider,
]);

const run = Effect.fn(function* scenario12(
  fixture: Fixture,
  command: ScaffoldCommand,
  scaffoldArguments: readonly string[],
  routeRefresh?: (appId: string) => void,
) {
  return yield* runScaffoldEffect(
    command,
    (() => {
      let flags = [...scaffoldArguments];
      if (command === 'action' && flags.includes('--action') && !flags.includes(scaffoldFlag.legalEntityScope)) {
        flags = [...flags, scaffoldFlag.legalEntityScope, 'optional'];
      }
      if (!flags.includes(scaffoldFlag.authorization)) {
        if (command === 'action') {
          flags = [
            ...flags,
            scaffoldFlag.authorization,
            'action_execution',
            '--provisioning',
            'tenant_membership_default',
          ];
        } else if (command === scaffoldCommand.outboxWorker) {
          flags = [...flags, scaffoldFlag.authorization, 'owner_local_background'];
        } else if (contextPermissionCommands.has(command)) {
          flags = [...flags, scaffoldFlag.authorization, 'context_permission', '--permission', 'module.access'];
        }
      }
      return flags;
    })(),
    {
      routeRefresh: ({ appId }) => Effect.sync(() => routeRefresh?.(appId)),
      workspaceRoot: fixture.root,
    },
  ).pipe(Effect.provide(NodeServices.layer));
});

/** Refusal must preserve the fixture byte-for-byte. */
const assertScaffoldRefused = Effect.fn(function* assertScaffoldRefused(
  fixture: Fixture,
  command: ScaffoldCommand,
  commandArguments: readonly string[],
  expected: RegExp,
) {
  const before = yield* snapshotTree(fixture.root);
  yield* expectFailure(run(fixture, command, commandArguments), (error) => expect(String(error)).toMatch(expected));
  expect(yield* snapshotTree(fixture.root)).toEqual(before);
});

const addInventoryItemResourceType = (fixture: Fixture): Effect.Effect<void, unknown> =>
  Effect.gen(function* scenario13() {
    const manifestPath = path.join(fixture.root, inventoryManifestFile);
    const manifest = yield* Effect.promise(() => readFile(manifestPath, 'utf-8'));
    yield* Effect.promise(() =>
      writeFile(
        manifestPath,
        manifest.replace(
          '    resourceTypes: [],',
          `    resourceTypes: [
      {
        capabilities: {
          graphVisible: false,
          linkable: true,
          mediaAttachable: false,
          searchable: true,
          timelineVisible: false,
        },
        description: 'Inventory item.',
        key: 'inventory.stock.item',
        label: 'Inventory item',
        owningModuleId: 'inventory.stock',
      },
    ],`,
        ),
        'utf-8',
      ),
    );
  });

it.live(
  'documents every command and treats --help as a write-free operation',
  Effect.fn(function* scenario14() {
    yield* Effect.all(
      (
        [
          'action',
          scaffoldCommand.actionService,
          scaffoldCommand.externalHttpAdapter,
          scaffoldCommand.microverticalActionBoundary,
          scaffoldCommand.microverticalPage,
          'module-contract',
          scaffoldCommand.moduleApi,
          scaffoldCommand.outboxMessage,
          scaffoldCommand.outboxWorker,
          'policy',
          scaffoldCommand.publicComponent,
          'report',
          scaffoldCommand.searchProviderAccess,
          scaffoldCommand.searchProvider,
        ] as const
      ).map(
        Effect.fn(function* scenario15(command) {
          const result = yield* runScaffoldEffect(command, ['--', '--help'], {
            workspaceRoot: path.join(tmpdir(), 'does-not-need-to-exist'),
          }).pipe(Effect.provide(NodeServices.layer));
          expect(result).toEqual({ help: getHelpText(command), kind: 'help' });
          if (result.kind !== 'help') {
            throw new Error('Expected help result');
          }
          expect(result.help).toMatch(new RegExp(`scaffold:${command}`, 'u'));
        }),
      ),
      { concurrency: 'unbounded' },
    );
    expect(getHelpText('action')).toMatch(/--vertical <vertical>/u);
    expect(getHelpText('action')).toMatch(/--scope core --module <core\.module>/u);
    expect(getHelpText(scaffoldCommand.microverticalPage)).toMatch(/--url <url>/u);
    expect(getHelpText(scaffoldCommand.microverticalPage)).toMatch(/defaults to \/<vertical>\/<page>/u);
    expect(getHelpText(scaffoldCommand.microverticalPage)).toMatch(/:parameter/u);
    expect(getHelpText(scaffoldCommand.microverticalPage)).toMatch(/\/contacts\/customers\/:id\/edit/u);
    expect(getHelpText(scaffoldCommand.externalHttpAdapter)).toMatch(
      /scaffold:external-http-adapter -- --vertical <vertical> --provider <provider> --operation <operation>/u,
    );
    expect(getHelpText(scaffoldCommand.externalHttpAdapter)).toMatch(
      /--vertical contacts --provider ares --operation subject/u,
    );
    expect(getHelpText(scaffoldCommand.searchProviderAccess)).toMatch(/--tenant-permission read_party_identity/u);
  }),
);

it.live(
  'search-provider access updates only generated access metadata and fails atomically on drift',
  Effect.fn(function* mergedScenario18() {
    yield* withFixture(
      Effect.fn(function* mergedScenario17(fixture) {
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'verticals/retired/node_modules'), {
            recursive: true,
          }),
        );
        yield* addInventoryItemResourceType(fixture);
        yield* run(fixture, scaffoldCommand.searchProvider, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.inventoryItems,
          scaffoldFlag.resource,
          'item',
        ]);
        yield* run(fixture, scaffoldCommand.searchProviderAccess, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.inventoryItems,
          scaffoldFlag.legalEntityScope,
          'optional',
          scaffoldFlag.accessFiltering,
          'tenant_scope',
          scaffoldFlag.requestFilters,
          'includeArchived',
          '--tenant-permission',
          'read_party_identity',
        ]);

        const [manifest, provider, contract] = yield* Effect.all(
          [
            readFixtureFile(fixture.root, inventoryManifestFile),
            readFixtureFile(fixture.root, inventorySearchProviderFile),
            readFixtureFile(fixture.root, inventorySearchContractFile),
          ],
          { concurrency: 'unbounded' },
        );
        expect(manifest).toMatch(
          /accessFiltering: 'tenant_scope'.*requestFilters: \['includeArchived'\].*tenantPermission: 'read_party_identity'/u,
        );
        expect(provider).toMatch(/legalEntityScope: 'optional'/u);
        expect(provider).toMatch(/permissionTarget: 'tenant'/u);
        expect(provider).toMatch(/kind: 'tenant', permission: 'read_party_identity'/u);
        expect(contract).toMatch(/includeArchived: Schema\.optionalKey\(Schema\.Boolean\)/u);

        const beforeProviderRerun = yield* snapshotTree(fixture.root);
        yield* run(fixture, scaffoldCommand.searchProvider, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.inventoryItems,
          scaffoldFlag.resource,
          'item',
        ]);
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeProviderRerun);

        const providerPath = path.join(fixture.root, inventorySearchProviderFile);
        yield* Effect.promise(() =>
          writeFile(providerPath, `${provider}\n// Owner-customized searchable semantics remain untouched.\n`),
        );
        const beforeIdempotentUpdate = yield* snapshotTree(fixture.root);
        yield* run(fixture, scaffoldCommand.searchProviderAccess, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.inventoryItems,
          scaffoldFlag.legalEntityScope,
          'optional',
          scaffoldFlag.accessFiltering,
          'tenant_scope',
          scaffoldFlag.requestFilters,
          'includeArchived',
          '--tenant-permission',
          'read_party_identity',
        ]);
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeIdempotentUpdate);
        yield* Effect.promise(() =>
          writeFile(providerPath, provider.replace('// @generated by OntOS Codesmith ', '// custom ')),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.searchProviderAccess,
          [
            scaffoldFlag.vertical,
            inventorySlug,
            '--name',
            fixtureName.inventoryItems,
            scaffoldFlag.legalEntityScope,
            'required',
            scaffoldFlag.accessFiltering,
            'resource_permission',
            scaffoldFlag.requestFilters,
            'includeArchived,role',
          ],
          /Codesmith-owned provider/u,
        );
      }),
    );
  }),
);

it.live(
  'generated API owner slots sort property keys before suffix variants',
  Effect.fn(function* scenario18() {
    yield* withFixture(
      Effect.fn(function* scenario19(fixture) {
        yield* run(fixture, scaffoldCommand.moduleApi, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          'party-match-decision',
        ]);
        yield* run(fixture, scaffoldCommand.moduleApi, [scaffoldFlag.vertical, inventorySlug, '--name', 'party-match']);
        const sources = yield* Effect.all(
          [inventoryManifestFile, inventoryRegistrationFile].map(
            Effect.fn(function* scenario20(owner) {
              return yield* readFixtureFile(fixture.root, owner);
            }),
          ),
          { concurrency: 'unbounded' },
        );
        for (const source of sources) {
          expect(source.indexOf("'party-match':") < source.indexOf("'party-match-decision':")).toBe(true);
        }
      }),
    );
  }),
);

it.live(
  'generated read clients fetch mounted owner URLs and support separately deployed hosts',
  Effect.fn(function* mergedScenario21() {
    yield* withFixture(
      Effect.fn(function* mergedScenario20(fixture) {
        yield* addInventoryItemResourceType(fixture);
        yield* run(fixture, scaffoldCommand.moduleApi, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.resourceDetail,
        ]);
        yield* run(fixture, scaffoldCommand.searchProvider, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.inventoryItems,
          scaffoldFlag.resource,
          'item',
        ]);
        yield* run(fixture, 'report', [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.stockLevels,
          scaffoldFlag.resource,
          'item',
        ]);
        yield* linkFixtureDependencies(fixture.root, appRoot, {
          '@app/shared-contracts': sharedContractsPackagePath,
          '@modern-js/plugin-bff': pluginBffNodeModulePath,
          effect: effectNodeModulePath,
        });
        const result = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            `import { Effect, Match, Result } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { executeResourceDetail, executeResourceDetailWithAuthorization } from './verticals/inventory-stock/src/api/resource-detail-client.ts';
import { loadInventoryItemsClient, loadInventoryItemsClientWithAuthorization } from './verticals/inventory-stock/src/api/inventory-items-search-client.ts';
import { loadStockLevelsClient, loadStockLevelsClientWithAuthorization } from './verticals/inventory-stock/src/api/stock-levels-report-client.ts';
import { NodeRuntime } from '${pathToFileURL(require.resolve('@effect/platform-node')).href}';
Effect.gen(function* generatedHttpProof() {
const calls = [];
let gatewayAttempts = 0;
const cases = [
        [executeResourceDetailWithAuthorization, {}, { ok: true }, executeResourceDetail],
        [loadInventoryItemsClientWithAuthorization, { query: 'chair' }, [], loadInventoryItemsClient],
        [loadStockLevelsClientWithAuthorization, { parameters: {} }, { rows: [] }, loadStockLevelsClient],
      ];
for (const [invoke, payload, response] of cases) {
        const fetch = (url, init) => {
          calls.push({ url: String(url), method: init.method, authorization: new Headers(init.headers).get('authorization'), correlationId: new Headers(init.headers).get('x-correlation-id') });
          return Promise.resolve(Response.json(response));
        };
        (yield* invoke(payload, 'Bearer proof', 'correlation-proof', { baseUrl: new URL('https://inventory.example.test/custom/inventory-stock-api') }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
      }
globalThis.location = { origin: 'https://shell.example.test', pathname: '/cs/inventory' };
for (const [invoke, payload, response] of cases) {
        (yield* invoke(payload, 'Bearer proof', 'correlation-proof').pipe(Effect.provideService(FetchHttpClient.Fetch, (url, init) => {
          calls.push({ url: String(url), method: init.method, authorization: new Headers(init.headers).get('authorization'), correlationId: new Headers(init.headers).get('x-correlation-id') });
          return Promise.resolve(Response.json(response));
        })));
      }
for (const [, payload, response, invoke] of cases) {
        (yield* invoke(payload, 'correlation-proof', { baseUrl: 'https://inventory.example.test/custom/inventory-stock-api' }).pipe(Effect.provideService(FetchHttpClient.Fetch, (url, init) => {
          if (String(url) === 'https://shell.example.test/shell-super-app-api/auth/gateway-context') {
            gatewayAttempts += 1;
            return Promise.resolve(Response.json({ expiresAt: 2_000_000_000, token: 'proof' }));
          }
          calls.push({ url: String(url), method: init.method, authorization: new Headers(init.headers).get('authorization'), correlationId: new Headers(init.headers).get('x-correlation-id') });
          return Promise.resolve(Response.json(response));
        })));
      }
const generatedProblem = {
        _tag: 'ResourceDetailUnavailableProblem',
        detail: 'Temporarily unavailable.',
        retryable: true,
        status: 503,
        title: 'Unavailable',
        type: 'urn:ontos:test:generated-problem',
      };
const generatedFailure = (yield* executeResourceDetailWithAuthorization(
          {},
          'Bearer proof',
          'correlation-proof',
          { baseUrl: 'https://inventory.example.test/custom/inventory-stock-api' },
        ).pipe(
          Effect.result,
          Effect.provideService(FetchHttpClient.Fetch, () => Promise.resolve(Response.json(generatedProblem, {
              headers: { 'content-type': 'application/problem+json' },
              status: 503,
            })),
          ),
        ));
if (!Result.isFailure(generatedFailure)) throw new Error('Expected generated client failure');
const preservesProblemDetails = Match.value(generatedFailure.failure).pipe(
        Match.tag('ResourceDetailUnavailableProblem', ({ status, retryable }) =>
          status === generatedProblem.status && retryable === true,
        ),
        Match.orElse(() => false),
      );
if (!preservesProblemDetails) {
        throw new Error('Generated client did not preserve the concrete Problem Details error');
      }
let endpointRequestsAfterGatewayFailure = 0;
const gatewayFailure = (yield* executeResourceDetail({}, 'failed-gateway-correlation', {
          baseUrl: 'https://inventory.example.test/custom/inventory-stock-api',
        }).pipe(
          Effect.provideService(FetchHttpClient.Fetch, (url) => {
            if (String(url) === 'https://shell.example.test/shell-super-app-api/auth/gateway-context') {
              gatewayAttempts += 1;
              return Promise.resolve(Response.json(
                {
                  _tag: 'GatewayUnavailableProblem',
                  detail: 'Gateway unavailable for generated-client proof.',
                  retryable: true,
                  status: 503,
                  title: 'Gateway unavailable',
                  type: 'https://ontos.dev/problems/gateway-unavailable',
                },
                { status: 503 },
              ));
            }
            endpointRequestsAfterGatewayFailure += 1;
            return Promise.resolve(Response.json({ ok: true }));
          }),
          Effect.flip,
        ));
const gatewayUnavailable = Match.value(gatewayFailure).pipe(
        Match.tag('GatewayUnavailableProblem', () => true),
        Match.orElse(() => false),
      );
console.log(JSON.stringify({ calls, endpointRequestsAfterGatewayFailure, gatewayAttempts, gatewayUnavailable }));
}).pipe(Effect.scoped, NodeRuntime.runMain);
`,
          ],
          { cwd: fixture.root, encoding: 'utf-8' },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const proof = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              calls: Schema.Array(Schema.Record(Schema.String, Schema.String)),
              endpointRequestsAfterGatewayFailure: Schema.Number,
              gatewayAttempts: Schema.Number,
              gatewayUnavailable: Schema.Boolean,
            }),
          ),
        )(result.stdout);
        expect(proof.calls).toEqual(
          [
            'https://inventory.example.test/custom/inventory-stock-api/reads/resource-detail',
            'https://inventory.example.test/custom/inventory-stock-api/inventory.stock/search/inventory-items',
            'https://inventory.example.test/custom/inventory-stock-api/inventory.stock/reports/stock-levels',
            'https://shell.example.test/inventory-stock-api/reads/resource-detail',
            'https://shell.example.test/inventory-stock-api/inventory.stock/search/inventory-items',
            'https://shell.example.test/inventory-stock-api/inventory.stock/reports/stock-levels',
            'https://inventory.example.test/custom/inventory-stock-api/reads/resource-detail',
            'https://inventory.example.test/custom/inventory-stock-api/inventory.stock/search/inventory-items',
            'https://inventory.example.test/custom/inventory-stock-api/inventory.stock/reports/stock-levels',
          ].map((url) => ({
            authorization: 'Bearer proof',
            correlationId: 'correlation-proof',
            method: 'POST',
            url,
          })),
        );
        expect(proof.gatewayAttempts).toBe(4);
        expect(proof.gatewayUnavailable).toBe(true);
        expect(proof.endpointRequestsAfterGatewayFailure).toBe(0);
      }),
    );
  }),
);

const compactGovernedSource = (source: string): string =>
  source.replaceAll(/\s+/gu, '').replaceAll(/,(?=[)}\]])/gu, '');
const inventorySharedApiFile = 'verticals/inventory-stock/shared/api.ts';

it.live(
  'all live Party read and search transports match actual scaffold output',
  Effect.fn(function* livePartyTransports() {
    yield* withFixture(
      Effect.fn(function* generatedTransportFixture(fixture) {
        yield* addInventoryItemResourceType(fixture);
        yield* run(fixture, scaffoldCommand.moduleApi, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.resourceDetail,
        ]);
        yield* run(fixture, scaffoldCommand.searchProvider, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.inventoryItems,
          scaffoldFlag.resource,
          'item',
        ]);
        const owner = path.join(appRoot, 'verticals/party-registry');
        const ownerFiles = yield* Effect.promise(() => readdir(path.join(owner, 'api')));
        const serverNames = ownerFiles.filter((name) => /-(?:read|search)-server\.ts$/u.test(name));
        expect(serverNames.length).toBe(18);
        yield* Effect.all(
          serverNames.map(
            Effect.fn(function* compareLiveTransport(serverName) {
              const search = serverName.endsWith('-search-server.ts');
              const suffix = search ? 'search' : 'read';
              const name = serverName.slice(0, -`-${suffix}-server.ts`.length);
              const camel = name.replaceAll(/-(?<letter>[a-z])/gu, (_, letter: string) => letter.toUpperCase());
              const pascal = `${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
              const fixtureNameValue = search ? 'inventory-items' : 'resource-detail';
              const fixtureCamel = search ? 'inventoryItems' : 'resourceDetail';
              const fixturePascal = search ? 'InventoryItems' : 'ResourceDetail';
              const clientName = `${name}${search ? '-search' : ''}-client.ts`;
              const normalize = (source: string): string =>
                compactGovernedSource(
                  source
                    .replaceAll(`/${name}`, `/${fixtureNameValue}`)
                    .replaceAll(pascal, fixturePascal)
                    .replaceAll(camel, fixtureCamel)
                    .replaceAll(`${fixturePascal}SearchClientOptions`, `${fixturePascal}ClientOptions`)
                    .replaceAll('partyRegistryApi', 'fixtureApi')
                    .replaceAll('/party-registry-api', '/inventory-stock-api'),
                );
              const expectedServer = yield* readFixtureFile(
                fixture.root,
                `verticals/inventory-stock/api/${fixtureNameValue}-${suffix}-server.ts`,
              );
              const expectedClient = yield* readFixtureFile(
                fixture.root,
                `verticals/inventory-stock/src/api/${fixtureNameValue}${search ? '-search' : ''}-client.ts`,
              );
              expect(
                normalize(yield* Effect.promise(() => readFile(path.join(owner, 'api', serverName), 'utf-8'))),
                serverName,
              ).toBe(compactGovernedSource(expectedServer));
              expect(
                normalize(yield* Effect.promise(() => readFile(path.join(owner, 'src/api', clientName), 'utf-8'))),
                clientName,
              ).toBe(compactGovernedSource(expectedClient));
            }),
          ),
          { concurrency: 'unbounded' },
        );
        const sharedApi = yield* readFixtureFile(fixture.root, inventorySharedApiFile);
        expect(sharedApi).not.toMatch(/governedHttpApi/u);
      }),
    );
  }),
);

it.live(
  'the migrated Party governed API slot accepts future generated additions',
  Effect.fn(function* mergedScenario22() {
    const source = yield* Effect.promise(() => readFile(path.join(appRoot, partyGovernedContractPath), 'utf-8'));
    const next = insertSortedSlot(
      source,
      GOVERNED_HTTP_API_ADDITION_SLOT_START,
      GOVERNED_HTTP_API_ADDITION_SLOT_END,
      ['.addHttpApi(FutureReadApi)'],
      (candidate) => candidate.startsWith('.addHttpApi(') && candidate.endsWith(')'),
    );
    expect(next).toMatch(/\.addHttpApi\(FutureReadApi\)/u);
  }),
);

const requiredGeneratedSlot = (source: string, start: string, end: string): string => {
  const slot = new RegExp(`${start}[\\s\\S]*?${end}`, 'u').exec(source)?.[0];
  if (slot === undefined) {
    expect.unreachable(`expected the generated slot between ${start} and ${end}`);
  }
  return slot;
};

/**
 * Moving a generated composition slot into a string literal leaves the real binding missing, so
 * the generator must refuse rather than accept the relocated copy as the composition point.
 */
const assertRelocatedSlotRefused = Effect.fn(function* assertRelocatedSlotRefused(
  fixture: Fixture,
  file: string,
  validSource: string,
  [slotStart, slotEnd]: readonly [string, string],
) {
  const slot = requiredGeneratedSlot(validSource, slotStart, slotEnd);
  yield* Effect.promise(() =>
    writeFile(file, `${validSource.replace(slot, '')}\nconst relocatedSlot = String.raw\`${slot}\`;\n`, 'utf-8'),
  );
  yield* assertScaffoldRefused(
    fixture,
    scaffoldCommand.moduleApi,
    [scaffoldFlag.vertical, inventorySlug, '--name', fixtureName.resourceDetail],
    /composition slots are not bound/u,
  );
  yield* Effect.promise(() => writeFile(file, validSource, 'utf-8'));
});
const assertGovernedReadClients = (clients: readonly string[]): void => {
  for (const client of clients) {
    expect(client).toMatch(/from '@app\/shared-contracts\/client-runtime'/u);
    expect(client).toMatch(/makeGovernedEffectBffClient\(/u);
    expect(client).toMatch(/defaultApiPrefix: '\/inventory-stock-api'/u);
    expect(client).toMatch(/operationGateway\.invoke\(\(credential\) =>/u);
    expect(client).toMatch(/WithAuthorization/u);
    expect(client).toMatch(/credential,\s+defaultApiPrefix: '\/inventory-stock-api',\s+requestCorrelation,/u);
    expect(client).not.toMatch(/makeEffectHttpApiClient|Context\.Reference|HttpClientRequest|HttpClient\.mapRequest/u);
  }
};
const assertGovernedReadProviders = (providers: readonly string[]): void => {
  for (const provider of providers) {
    expect(provider).toMatch(/defineRead\(/u);
    expect(provider).toMatch(/legalEntityScope: 'required'/u);
    expect(provider).toMatch(/permissionTarget: 'module'/u);
    expect(provider).not.toMatch(/CoreDatabase|ScopedTransactionExecutor|from 'pg'/u);
  }
};
const assertGovernedReadServers = (servers: readonly string[]): void => {
  for (const server of servers) {
    expect(server).toMatch(/makeGovernedReadHttpHandler\(\{/u);
    expect(server).toMatch(/authenticatePrincipal: authenticateOperationPrincipal/u);
    expect(server).toMatch(/registration: \w+Read/u);
    expect(server).not.toMatch(/ReadRuntime|Match\.tags|catchTags|bearerChallenge/u);
    expect(server).not.toMatch(/tenantId|legalEntityId|principalId|CoreDatabase|from 'pg'/u);
  }
};
const assertComposedGovernedReads = (composedApi: string, composedHandlers: string): void => {
  for (const [contract, layer] of [
    ['InventoryItemsSearchApi', 'inventoryItemsReadApiLive'],
    ['ResourceDetailApi', 'resourceDetailReadApiLive'],
    ['StockLevelsReportApi', 'stockLevelsReadApiLive'],
  ] as const) {
    expect(composedApi).toMatch(new RegExp(`import \\{ ${contract} \\}`, 'u'));
    expect(composedApi).toMatch(new RegExp(`\\.addHttpApi\\(${contract}\\)`, 'u'));
    expect(composedHandlers).toMatch(new RegExp(`import \\{ ${layer} \\}`, 'u'));
    expect(composedHandlers).toMatch(
      new RegExp(`${layer}\\.pipe\\([\\s\\S]*?GovernedReadLayer\\.provide\\(governedReadRuntimeLive\\)`, 'u'),
    );
  }
};
const assertGovernedProblemDetailsContracts = (contracts: readonly string[]): void => {
  for (const contract of contracts) {
    expect(contract).toMatch(
      /import \{\s*makeProblemDetailsSchema,\s*makeRetryableProblemDetailsSchema,?\s*\} from '@app\/shared-contracts\/problem-details';/u,
    );
    expect(contract).toMatch(/makeProblemDetailsSchema\([^)]*,\s*409,?\s*\)/u);
    expect(contract).toMatch(/makeRetryableProblemDetailsSchema\([^)]*,\s*503,?\s*\)/u);
    expect(contract).not.toMatch(/application\/problem\+json|HttpApiSchema/u);
  }
};

it.live(
  'governed contribution generators patch owner contracts and lazy adapters atomically',
  Effect.fn(function* mergedScenario29() {
    yield* withFixture(
      Effect.fn(function* mergedScenario28(fixture) {
        const manifestPath = path.join(fixture.root, inventoryManifestFile);
        yield* addInventoryItemResourceType(fixture);

        yield* run(fixture, scaffoldCommand.moduleApi, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.resourceDetail,
        ]);
        yield* run(fixture, scaffoldCommand.moduleApi, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          'resource-history',
        ]);
        yield* run(fixture, scaffoldCommand.publicComponent, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          'inventory-summary',
        ]);
        yield* run(fixture, scaffoldCommand.publicComponent, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          'inventory-alerts',
        ]);
        yield* run(fixture, scaffoldCommand.searchProvider, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.inventoryItems,
          scaffoldFlag.resource,
          'item',
        ]);
        yield* run(fixture, scaffoldCommand.searchProvider, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          'inventory-suppliers',
          scaffoldFlag.resource,
          'item',
        ]);
        yield* run(fixture, 'report', [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.stockLevels,
          scaffoldFlag.resource,
          'item',
        ]);

        const [nextManifest, registration, federation] = yield* Effect.all(
          [
            Effect.promise(() => readFile(manifestPath, 'utf-8')),
            readFixtureFile(fixture.root, inventoryRegistrationFile),
            readFixtureFile(fixture.root, inventoryFederationConfigFile),
          ],
          { concurrency: 'unbounded' },
        );
        expect(nextManifest).toMatch(/inventory\.stock\.component\.inventory-summary/u);
        expect(nextManifest).toMatch(/inventory\.stock\.search\.inventory-items/u);
        expect(nextManifest).toMatch(/inventory\.stock\.report\.stock-levels/u);
        expect(registration).toMatch(/import\('\.\/src\/api\/resource-detail-client\.ts'\)/u);
        expect(registration).toMatch(/import\('\.\/src\/api\/inventory-items-search-client\.ts'\)/u);
        expect(registration).toMatch(/import\('\.\/src\/api\/stock-levels-report-client\.ts'\)/u);
        expect(federation).toMatch(/\.\/InventoryAlerts/u);
        expect(federation).toMatch(/\.\/InventorySummary/u);
        expect(nextManifest).not.toMatch(/import\('/u);
        const searchClient = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/api/inventory-items-search-client.ts',
        );
        const reportClient = yield* readFixtureFile(fixture.root, inventoryReportClientFile);
        expect(searchClient).toMatch(/export interface InventoryItemsClientOptions/u);
        expect(searchClient).not.toMatch(/export interface InventoryItemsSearchClientOptions/u);
        expect(reportClient).toMatch(/export interface StockLevelsClientOptions/u);
        expect(reportClient).not.toMatch(/export interface StockLevelsReportClientOptions/u);
        const moduleApiClient = yield* readFixtureFile(fixture.root, inventoryModuleApiClientFile);
        const moduleApiContract = yield* readFixtureFile(fixture.root, inventoryModuleApiContractFile);
        const secondModuleApiContract = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/shared/apis/resource-history.ts',
        );
        const secondModuleApiClient = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/api/resource-history-client.ts',
        );
        const searchProvider = yield* readFixtureFile(fixture.root, inventorySearchProviderFile);
        const reportProvider = yield* readFixtureFile(fixture.root, inventoryReportProviderFile);
        const moduleApiRead = yield* readFixtureFile(fixture.root, inventoryModuleApiReadFile);
        const searchServer = yield* readFixtureFile(fixture.root, inventorySearchServerFile);
        const reportServer = yield* readFixtureFile(fixture.root, inventoryReportServerFile);
        const moduleApiServer = yield* readFixtureFile(fixture.root, inventoryModuleApiServerFile);
        const operationBoundary = yield* readFixtureFile(fixture.root, inventoryActionPrincipalFile);
        const composedApi = yield* readFixtureFile(fixture.root, 'verticals/inventory-stock/shared/api.ts');
        const composedHandlers = yield* readFixtureFile(fixture.root, inventoryHandlerRootFile);
        expect(searchClient).toMatch(/api: InventoryItemsSearchApi,/u);
        expect(reportClient).toMatch(/api: StockLevelsReportApi,/u);
        expect(moduleApiContract).toMatch(
          /headers: \{\},\s+params: \{\},\s+payload: ResourceDetailRequestSchema,\s+query: \{\}/u,
        );
        expect(moduleApiClient).toMatch(
          /client\.resourceDetail\.execute\(\{\s+headers: \{\},\s+params: \{\},\s+payload,\s+query: \{\},?\s+\}\)/u,
        );
        expect(moduleApiContract).toMatch(/HttpApiGroup\.make\('resourceDetail'\)/u);
        expect(secondModuleApiContract).toMatch(/HttpApiGroup\.make\('resourceHistory'\)/u);
        expect(secondModuleApiClient).toMatch(/client\.resourceHistory\.execute\(/u);
        assertGovernedReadClients([moduleApiClient, searchClient, reportClient]);
        expect(searchClient).not.toMatch(/\.provider\.ts|import\(/u);
        expect(reportClient).not.toMatch(/\.provider\.ts|import\(/u);
        assertGovernedReadProviders([searchProvider, reportProvider]);
        expect(searchProvider).toMatch(/result\.map\(\(\{ ref \}\) => ref\)/u);
        expect(moduleApiRead).toMatch(/defineRead\(/u);
        expect(moduleApiRead).toMatch(/legalEntityScope: 'required'/u);
        assertGovernedReadServers([moduleApiServer, searchServer, reportServer]);
        expect(operationBoundary).toMatch(/export const authenticateOperationPrincipal/u);
        assertComposedGovernedReads(composedApi, composedHandlers);
        const searchContract = yield* readFixtureFile(fixture.root, inventorySearchContractFile);
        const reportContract = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/shared/apis/stock-levels-report.ts',
        );
        assertGovernedProblemDetailsContracts([moduleApiContract, searchContract, reportContract]);
        expect(searchContract).toMatch(
          /HttpApiEndpoint\.post\('execute', '\/inventory\.stock\/search\/inventory-items'/u,
        );
        expect(searchContract).not.toMatch(/tenantId|legalEntityId|principalId/u);
        expect(searchContract).toMatch(/PolicyConflictProblem/u);
        expect(searchContract).toMatch(
          /makeProblemDetailsSchema\(\s*'InventoryItemsProviderPolicyConflictProblem',\s*409,?\s*\)/u,
        );
        expect(searchContract).toMatch(/HttpApiGroup\.make\('inventoryItemsSearch'\)/u);

        yield* linkFixtureDependencies(fixture.root, appRoot, {
          '@app/core-runtime': 'packages/core-runtime',
          '@app/shared-contracts': sharedContractsPackagePath,
          '@modern-js/plugin-bff': pluginBffNodeModulePath,
          effect: effectNodeModulePath,
        });
        yield* write(
          fixture.root,
          inventoryActionPrincipalFile,
          `import { Effect, Layer, Redacted } from 'effect';

const principal = {
  authContextRef: 'job:generated-fixture:run:governed-read',
  authMethod: 'system',
  principalId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
};

export const ActionPrincipalVerifierLive = Layer.empty;

export const authenticateOperationPrincipal = (authorization, problems) =>
  Redacted.value(authorization) === 'Bearer proof'
    ? Effect.succeed(principal)
    : Effect.fail(problems.authentication());
`,
        );
        yield* write(
          fixture.root,
          'execute-generated-governed-reads.mts',
          `import { ReadRuntime } from '@app/core-runtime';
import {
  defineEffectBff,
  Effect,
  HttpApiBuilder,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import { resourceDetailReadApiLive } from './verticals/inventory-stock/api/resource-detail-read-server.ts';
import { resourceHistoryReadApiLive } from './verticals/inventory-stock/api/resource-history-read-server.ts';
import { inventoryItemsReadApiLive } from './verticals/inventory-stock/api/inventory-items-search-server.ts';
import { inventorySuppliersReadApiLive } from './verticals/inventory-stock/api/inventory-suppliers-search-server.ts';
import { stockLevelsReadApiLive } from './verticals/inventory-stock/api/stock-levels-report-server.ts';
import generatedRuntime from './verticals/inventory-stock/api/index.ts';
import { fixtureApi } from './verticals/inventory-stock/shared/api.ts';
import { NodeRuntime } from '${pathToFileURL(require.resolve('@effect/platform-node')).href}';
Effect.gen(function* generatedHttpProof() {
const calls = [];
const readRuntime = {
  runRead: ({ input, principal, registration, transport }) =>
    Effect.sync(() => {
      calls.push({ input, principal, readKey: registration.descriptor.readKey, transport });
      if (registration.descriptor.readKey.endsWith('.resource-detail')) return { ok: true };
      if (registration.descriptor.accessKind === 'search') return [];
      return { rows: [] };
    }),
};
const readLayer = Layer.succeed(ReadRuntime, readRuntime);
const fixtureHandlersLive = HttpApiBuilder.group(fixtureApi, 'fixture', (handlers) =>
  handlers.handle('readiness', () => Effect.succeed({ ok: true })),
);
const handlers = Layer.mergeAll(
  fixtureHandlersLive,
  inventoryItemsReadApiLive,
  inventorySuppliersReadApiLive,
  resourceDetailReadApiLive,
  resourceHistoryReadApiLive,
  stockLevelsReadApiLive,
).pipe(Layer.provide(readLayer));
const runtime = defineEffectBff({
  api: fixtureApi,
  layer: HttpApiBuilder.layer(fixtureApi).pipe(Layer.provide(handlers)),
});
const server = runtime.createHandler();
const generatedServer = generatedRuntime.createHandler();
const requests = [
  ['/reads/resource-detail', {}],
  ['/inventory.stock/search/inventory-items', { query: 'chair' }],
  ['/inventory.stock/search/inventory-suppliers', { query: 'supplier' }],
  ['/inventory.stock/reports/stock-levels', { parameters: {} }],
];
yield* Effect.addFinalizer(() => Effect.gen(function* disposeGeneratedServers() {
  (yield* Effect.promise(() => generatedServer.dispose()));
  (yield* Effect.promise(() => server.dispose()));
}));
const successes = [];
for (const [route, payload] of requests) {
    const response = (yield* Effect.promise(() => server.handler(
      new Request('http://fixture.test' + route, {
        body: JSON.stringify(payload),
        headers: {
          authorization: 'Bearer proof',
          'content-type': 'application/json',
          'x-correlation-id': 'generated-correlation',
        },
        method: 'POST',
      }),
    )));
    successes.push({ body: (yield* Effect.promise(() => response.json())), status: response.status });
  }
const callsAfterSuccess = calls.length;
const missingCorrelationStatuses = [];
for (const [route, payload] of requests) {
    const response = (yield* Effect.promise(() => server.handler(
      new Request('http://fixture.test' + route, {
        body: JSON.stringify(payload),
        headers: { authorization: 'Bearer proof', 'content-type': 'application/json' },
        method: 'POST',
      }),
    )));
    missingCorrelationStatuses.push(response.status);
  }
const generatedRootResponse = (yield* Effect.promise(() => generatedServer.handler(
    new Request('http://fixture.test/reads/resource-detail', {
      body: JSON.stringify({}),
      headers: { authorization: 'Bearer proof', 'content-type': 'application/json' },
      method: 'POST',
    }),
  )));
console.log(
    JSON.stringify({
      calls,
      callsAfterSuccess,
      generatedRootStatus: generatedRootResponse.status,
      missingCorrelationStatuses,
      successes,
    }),
  );
}).pipe(Effect.scoped, NodeRuntime.runMain);
`,
        );
        const execution = spawnSync(
          process.execPath,
          ['--experimental-strip-types', 'execute-generated-governed-reads.mts'],
          {
            cwd: fixture.root,
            encoding: 'utf-8',
            env: {
              DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin@localhost:5433/ontos',
              DATABASE_URL: 'postgresql://ontos_runtime:runtime@localhost:5433/ontos',
            },
          },
        );
        expect(execution.status, execution.stderr).toBe(0);
        const expectedGeneratedPrincipal = {
          authContextRef: 'job:generated-fixture:run:governed-read',
          authMethod: 'system',
          principalId: '00000000-0000-4000-8000-000000000001',
          tenantId: '00000000-0000-4000-8000-000000000002',
        };
        const expectedGeneratedTransport = {
          correlationId: 'generated-correlation',
        };
        const lastGeneratedLine = execution.stdout.trim().split('\n').at(-1);
        if (lastGeneratedLine === undefined) {
          expect.unreachable('expected generated runtime output');
        }
        expect(JSON.parse(lastGeneratedLine)).toEqual({
          calls: [
            {
              input: {},
              principal: expectedGeneratedPrincipal,
              readKey: 'inventory.stock.api.resource-detail',
              transport: expectedGeneratedTransport,
            },
            {
              input: { query: 'chair' },
              principal: expectedGeneratedPrincipal,
              readKey: 'inventory.stock.search.inventory-items',
              transport: expectedGeneratedTransport,
            },
            {
              input: { query: 'supplier' },
              principal: expectedGeneratedPrincipal,
              readKey: 'inventory.stock.search.inventory-suppliers',
              transport: expectedGeneratedTransport,
            },
            {
              input: { parameters: {} },
              principal: expectedGeneratedPrincipal,
              readKey: 'inventory.stock.report.stock-levels',
              transport: expectedGeneratedTransport,
            },
          ],
          callsAfterSuccess: 4,
          generatedRootStatus: 400,
          missingCorrelationStatuses: [400, 400, 400, 400],
          successes: [
            { body: { ok: true }, status: 200 },
            { body: [], status: 200 },
            { body: [], status: 200 },
            { body: { rows: [] }, status: 200 },
          ],
        });

        // Restore the generated contract after the execution-only authentication stub. Reruns
        // must validate the real owned boundary, not silently accept handwritten fixture code.
        yield* write(fixture.root, inventoryActionPrincipalFile, operationBoundary);
        const packageJson = yield* decodeFixturePackage(yield* readFixtureFile(fixture.root, inventoryPackageFile));
        expect(packageJson.dependencies['@app/shared-contracts']).toBe(workspaceVersion);

        // Owner contracts, reads, and clients remain adaptable; thin HTTP adapters stay generator-owned.
        const adaptedGeneratedArtifacts = [
          [
            inventoryModuleApiContractFile,
            'export const ResourceDetailOwnerExtensionSchema = Schema.Struct({ note: Schema.String });',
          ],
          [inventoryModuleApiReadFile, 'export const resourceDetailOwnerProjection = (value: string) => value;'],
          [inventoryModuleApiClientFile, '// Owner-maintained client documentation.'],
          [inventorySearchProviderFile, 'export const inventoryItemsOwnerRanking = (score: number) => score;'],
          [
            inventorySearchContractFile,
            'export const InventoryItemsOwnerFilterSchema = Schema.Struct({ tag: Schema.String });',
          ],
          [inventorySearchClientFile, '// Owner-maintained search client documentation.'],
          [inventoryReportProviderFile, 'export const stockLevelsOwnerProjection = (column: string) => column;'],
          [
            inventoryReportContractFile,
            'export const StockLevelsOwnerColumnSchema = Schema.Struct({ column: Schema.String });',
          ],
          [inventoryReportClientFile, '// Owner-maintained report client documentation.'],
        ] as const;
        yield* Effect.all(
          adaptedGeneratedArtifacts.map(
            Effect.fn(function* mergedScenario27([relativePath, ownerAddition]) {
              const generated = yield* readFixtureFile(fixture.root, relativePath);
              yield* write(fixture.root, relativePath, `${generated}\n${ownerAddition}\n`);
            }),
          ),
          { concurrency: 'unbounded' },
        );

        const adaptedManifest = yield* readFixtureFile(fixture.root, inventoryManifestFile);
        expect(adaptedManifest).toMatch(/dimensions: \[\]/u);
        expect(adaptedManifest).toMatch(/label: 'Stock Levels'/u);
        yield* write(
          fixture.root,
          inventoryManifestFile,
          adaptedManifest
            .replace('dimensions: []', "dimensions: ['warehouse']")
            .replace("label: 'Stock Levels'", "label: 'Warehouse stock'"),
        );

        const beforeRepeat = yield* snapshotTree(fixture.root);
        yield* run(fixture, scaffoldCommand.moduleApi, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.resourceDetail,
        ]);
        yield* run(fixture, scaffoldCommand.searchProvider, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.inventoryItems,
          scaffoldFlag.resource,
          'item',
        ]);
        yield* run(fixture, 'report', [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.stockLevels,
          scaffoldFlag.resource,
          'item',
        ]);
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeRepeat);
        yield* expectFailure(
          run(fixture, scaffoldCommand.publicComponent, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--name',
            'inventory-summary',
          ]),
          (error) => expect(String(error)).toMatch(/refusing to overwrite/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeRepeat);
        for (const generated of [
          {
            command: scaffoldCommand.moduleApi,
            name: fixtureName.resourceDetail,
            resource: false,
            server: 'resource-detail-read-server.ts',
          },
          {
            command: scaffoldCommand.searchProvider,
            name: fixtureName.inventoryItems,
            resource: true,
            server: 'inventory-items-search-server.ts',
          },
          {
            command: 'report',
            name: fixtureName.stockLevels,
            resource: true,
            server: 'stock-levels-report-server.ts',
          },
        ] as const) {
          // Byte-identical owned output is a deterministic no-op for every governed read kind.
          yield* run(fixture, generated.command, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--name',
            generated.name,
            ...(generated.resource ? [scaffoldFlag.resource, 'item'] : []),
          ]);
          expect(yield* snapshotTree(fixture.root)).toEqual(beforeRepeat);
          const serverPath = path.join(fixture.root, 'verticals/inventory-stock/api', generated.server);
          const ownedServer = yield* Effect.promise(() => readFile(serverPath, 'utf-8'));
          yield* Effect.promise(() => writeFile(serverPath, `${ownedServer}// owner customization\n`, 'utf-8'));
          yield* expectFailure(
            run(fixture, generated.command, [
              scaffoldFlag.vertical,
              inventorySlug,
              '--name',
              generated.name,
              ...(generated.resource ? [scaffoldFlag.resource, 'item'] : []),
            ]),
            (error) => expect(String(error)).toMatch(/refusing to overwrite/u),
          );
          yield* Effect.promise(() => writeFile(serverPath, ownedServer, 'utf-8'));
        }
        const sharedApiPath = path.join(fixture.root, inventorySharedApiFile);
        const validSharedApi = yield* Effect.promise(() => readFile(sharedApiPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(
            sharedApiPath,
            validSharedApi.replace(
              '// </generated-governed-http-api-additions>',
              'ownerCustomLayer()\n  // </generated-governed-http-api-additions>',
            ),
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.moduleApi,
          [scaffoldFlag.vertical, inventorySlug, '--name', fixtureName.resourceDetail],
          /composition slots are not bound|unsupported developer content/u,
        );
        yield* Effect.promise(() => writeFile(sharedApiPath, validSharedApi, 'utf-8'));

        yield* assertRelocatedSlotRefused(fixture, sharedApiPath, validSharedApi, [
          GOVERNED_HTTP_API_ADDITION_SLOT_START,
          GOVERNED_HTTP_API_ADDITION_SLOT_END,
        ]);

        const registrationPath = path.join(fixture.root, 'verticals/inventory-stock/vertical.registration.ts');
        const validRegistration = yield* Effect.promise(() => readFile(registrationPath, 'utf-8'));
        const resourceDetailRegistration =
          "      'resource-detail': () => import('./src/api/resource-detail-client.ts'),\n";
        const wrongCategoryRegistration = validRegistration.replace(
          '// </generated-module-registration-search>',
          `${resourceDetailRegistration}      // </generated-module-registration-search>`,
        );
        for (const invalidRegistration of [
          wrongCategoryRegistration,
          wrongCategoryRegistration.replace(
            /^\s*'resource-detail': \(\) => import\('\.\/src\/api\/resource-detail-client\.ts'\),\n/mu,
            '',
          ),
        ]) {
          yield* Effect.promise(() => writeFile(registrationPath, invalidRegistration, 'utf-8'));
          yield* assertScaffoldRefused(
            fixture,
            scaffoldCommand.moduleApi,
            [scaffoldFlag.vertical, inventorySlug, '--name', fixtureName.resourceDetail],
            /wrong contribution category/u,
          );
        }
        yield* Effect.promise(() => writeFile(registrationPath, validRegistration, 'utf-8'));

        const handlerRootPath = path.join(fixture.root, inventoryHandlerRootFile);
        const validHandlerRoot = yield* Effect.promise(() => readFile(handlerRootPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(
            handlerRootPath,
            validHandlerRoot.replace(
              /resourceDetailReadApiLive\.pipe\(\s*GovernedReadLayer\.provide\(governedReadRuntimeLive\),?\s*\),/u,
              'resourceDetailReadApiLive.pipe(\n    GovernedReadLayer.provide(governedReadRuntimeLive),\n    GovernedReadLayer.provide(ownerCustomizedRuntime),\n  ),',
            ),
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.moduleApi,
          [scaffoldFlag.vertical, inventorySlug, '--name', fixtureName.resourceDetail],
          /contains drift/u,
        );
        yield* Effect.promise(() => writeFile(handlerRootPath, validHandlerRoot, 'utf-8'));
        yield* assertRelocatedSlotRefused(fixture, handlerRootPath, validHandlerRoot, [
          GOVERNED_HTTP_HANDLER_LAYER_SLOT_START,
          GOVERNED_HTTP_HANDLER_LAYER_SLOT_END,
        ]);
        yield* expectFailure(
          run(fixture, scaffoldCommand.moduleApi, [scaffoldFlag.vertical, inventorySlug, '--name', '../unsafe']),
          (error) => expect(String(error)).toMatch(/lower-kebab-case/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeRepeat);
        const billingFederationPath = path.join(fixture.root, 'verticals/billing/module-federation.config.ts');
        yield* Effect.promise(() =>
          writeFile(
            billingFederationPath,
            `const ignored = /exposes: \\{\\}/u;
// exposes: {}
export default {
  exposes: {},
  manifest: {
    additionalData: ({ stats }) => ({ exposes: stats.exposes.map(String) }),
  },
};
void ignored;
`,
            'utf-8',
          ),
        );
        yield* run(fixture, scaffoldCommand.publicComponent, [
          scaffoldFlag.vertical,
          'billing',
          '--name',
          'billing-summary',
        ]);
        const commentSafeFederation = yield* Effect.promise(() => readFile(billingFederationPath, 'utf-8'));
        expect(commentSafeFederation).toMatch(/\/exposes: \\\{\\\}\/u/u);
        expect(commentSafeFederation).toMatch(/\.\/BillingSummary/u);
        yield* Effect.promise(() => writeFile(billingFederationPath, 'export default {};\n', 'utf-8'));
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.publicComponent,
          [scaffoldFlag.vertical, 'billing', '--name', 'billing-details'],
          /exposes object is missing/u,
        );
      }),
    );
  }),
);

it.live(
  'governed contribution reruns cannot be spoofed by comments or corrupt owner slots',
  Effect.fn(function* mergedScenario34() {
    yield* withFixture(
      Effect.fn(function* mergedScenario33(fixture) {
        const scaffoldArguments = [scaffoldFlag.vertical, inventorySlug, '--name', fixtureName.resourceDetail] as const;
        yield* run(fixture, scaffoldCommand.moduleApi, scaffoldArguments);
        const apiContract = yield* readFixtureFile(fixture.root, inventoryModuleApiContractFile);
        const assertInvalidApiContractRerunRejected = (invalidApiContract: string): Effect.Effect<void, unknown> =>
          Effect.gen(function* mergedScenario32() {
            yield* write(fixture.root, inventoryModuleApiContractFile, invalidApiContract);
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.moduleApi,
              scaffoldArguments,
              /refusing to overwrite existing business file/u,
            );
          });
        yield* assertInvalidApiContractRerunRejected(apiContract.replace('/reads/resource-detail', '/reads/wrong'));
        yield* assertInvalidApiContractRerunRejected(
          apiContract.replace(
            "HttpApiEndpoint.post('execute', '/reads/resource-detail', {",
            "HttpApiEndpoint.post('wrong', '/reads/resource-detail', {",
          ),
        );
        yield* assertInvalidApiContractRerunRejected(
          apiContract.replace(
            /\.add\(\n {2}HttpApiGroup\.make\('resourceDetail'\)\.add\([\s\S]*?\n {2}\),\n\);\n$/u,
            ".add(HttpApiGroup.make('resourceDetail'));\n",
          ),
        );
        yield* write(fixture.root, inventoryModuleApiContractFile, apiContract);
        const manifest = yield* readFixtureFile(fixture.root, inventoryManifestFile);
        const ownerImport = "import { ResourceDetailApi } from './shared/apis/resource-detail.ts';";
        yield* write(
          fixture.root,
          inventoryManifestFile,
          `${manifest.replace(ownerImport, '')}\n/* ${ownerImport} */\n`,
        );
        yield* run(fixture, scaffoldCommand.moduleApi, scaffoldArguments);
        const repairedManifest = yield* readFixtureFile(fixture.root, inventoryManifestFile);
        expect(repairedManifest.split(/\r?\n/u).filter((line) => line === ownerImport).length).toBe(1);

        const registration = yield* readFixtureFile(fixture.root, inventoryRegistrationFile);
        const entry = "'resource-detail': () => import('./src/api/resource-detail-client.ts'),";
        const corrupted = registration.replace(entry, `${entry}\n${entry}`);
        yield* write(fixture.root, inventoryRegistrationFile, corrupted);
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.moduleApi,
          scaffoldArguments,
          /generated export already exists|generated owner slot/u,
        );

        yield* write(fixture.root, inventoryRegistrationFile, registration);
        yield* write(
          fixture.root,
          inventoryRegistrationFile,
          registration.replace(entry, "'resource-detail': () => import('./src/api/evil-client.ts'),"),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.moduleApi,
          scaffoldArguments,
          /generated owner slot contains mismatched identity/u,
        );

        const wrongSlotRegistration = registration
          .replace(`${entry}\n`, '')
          .replace(
            '      // </generated-module-registration-search>',
            `      ${entry}\n      // </generated-module-registration-search>`,
          );
        yield* write(fixture.root, inventoryRegistrationFile, wrongSlotRegistration);
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.moduleApi,
          scaffoldArguments,
          /generated owner slot contains mismatched identity/u,
        );

        yield* write(
          fixture.root,
          inventoryRegistrationFile,
          registration.replace(
            entry,
            "'unrelated': () => import('./src/api/unrelated-client.ts') /* 'resource-detail': spoof */,",
          ),
        );
        yield* run(fixture, scaffoldCommand.moduleApi, scaffoldArguments);
        const commentSafeRegistration = yield* readFixtureFile(fixture.root, inventoryRegistrationFile);
        expect(commentSafeRegistration.split(entry).length - 1).toBe(1);

        yield* write(
          fixture.root,
          inventoryManifestFile,
          repairedManifest.replace(ownerImport, "import { ResourceDetailApi } from './shared/apis/evil.ts';"),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.moduleApi,
          scaffoldArguments,
          /generated owner import binding conflicts/u,
        );
      }),
    );
  }),
);

it.live(
  'adapted governed artifacts require executable owner identity instead of comments or strings',
  Effect.fn(function* mergedScenario41() {
    yield* withFixture(
      Effect.fn(function* mergedScenario40(fixture) {
        const assertSpoofsRejected = (
          spoofs: readonly (readonly [string, string])[],
          command: Parameters<typeof run>[1],
          commandArguments: readonly string[],
        ): Effect.Effect<void, unknown> =>
          Effect.gen(function* mergedScenario38() {
            const [spoof, ...remaining] = spoofs;
            if (spoof === undefined) {
              return;
            }
            const [file, identity] = spoof;
            const current = yield* readFixtureFile(fixture.root, file);
            const removedIdentity = 'const removedIdentity = undefined;';
            yield* write(
              fixture.root,
              file,
              `${current.replace(identity, removedIdentity)}\n/* ${identity} */\nconst identitySpoof = ${JSON.stringify(identity)};\n`,
            );
            yield* assertScaffoldRefused(
              fixture,
              command,
              commandArguments,
              /refusing to overwrite existing business file/u,
            );
            yield* write(fixture.root, file, current);
            yield* assertSpoofsRejected(remaining, command, commandArguments);
          });
        yield* addInventoryItemResourceType(fixture);
        const moduleArguments = [scaffoldFlag.vertical, inventorySlug, '--name', fixtureName.resourceDetail] as const;
        yield* run(fixture, scaffoldCommand.moduleApi, moduleArguments);
        const moduleSpoofs = [
          [inventoryModuleApiContractFile, "export const ResourceDetailApi = HttpApi.make('ResourceDetailApi')"],
          [inventoryModuleApiReadFile, 'export const resourceDetailRead = defineRead('],
          [inventoryModuleApiServerFile, 'export const resourceDetailReadApiLive = HttpApiBuilder.group('],
        ] as const;
        yield* assertSpoofsRejected(moduleSpoofs, scaffoldCommand.moduleApi, moduleArguments);

        const assertAdaptationRejected = (
          file: string,
          adapt: (source: string) => string,
        ): Effect.Effect<void, unknown> =>
          Effect.gen(function* mergedScenario39() {
            const current = yield* readFixtureFile(fixture.root, file);
            yield* write(fixture.root, file, adapt(current));
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.moduleApi,
              moduleArguments,
              /refusing to overwrite existing business file/u,
            );
            yield* write(fixture.root, file, current);
          });
        yield* assertAdaptationRejected(
          inventoryModuleApiContractFile,
          (source) =>
            `${source.replace(
              "export const ResourceDetailApi = HttpApi.make('ResourceDetailApi')",
              "namespace Decoy { export const ResourceDetailApi = HttpApi.make('ResourceDetailApi')",
            )}\n}`,
        );
        yield* assertAdaptationRejected(inventoryActionGatewayFile, (source) =>
          source.replace(
            'export const operationGateway = makeOperationGateway();',
            "namespace Decoy { export const operationGateway = makeOperationGateway(); }\nconst spoof = 'export const operationGateway = actionGateway';",
          ),
        );
        yield* assertAdaptationRejected(
          inventoryModuleApiServerFile,
          (source) =>
            `${source.replace(
              'authenticatePrincipal: authenticateOperationPrincipal',
              'authenticatePrincipal: unverifiedPrincipal',
            )}\nconst unverifiedPrincipal = authenticateOperationPrincipal;`,
        );
        yield* assertAdaptationRejected(
          inventoryModuleApiServerFile,
          (source) =>
            `${source.replace('registration: resourceDetailRead', 'registration: otherRead')}\nvoid ReadRuntime;`,
        );
        yield* assertAdaptationRejected(
          inventoryModuleApiServerFile,
          (source) =>
            `${source.replace('makeGovernedReadHttpHandler({', 'unsafeReadHandler({')}\nconst spoof = '.runRead({';`,
        );

        const searchArguments = [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.inventoryItems,
          scaffoldFlag.resource,
          'item',
        ] as const;
        yield* run(fixture, scaffoldCommand.searchProvider, searchArguments);
        const providerSpoofs = [
          [inventorySearchProviderFile, 'export const inventoryItemsRead = defineRead('],
          [
            inventorySearchContractFile,
            "export const InventoryItemsSearchApi = HttpApi.make('InventoryItemsSearchApi')",
          ],
          [inventorySearchServerFile, 'export const inventoryItemsReadApiLive = HttpApiBuilder.group('],
        ] as const;
        yield* assertSpoofsRejected(providerSpoofs, scaffoldCommand.searchProvider, searchArguments);
      }),
    );
  }),
);

it.live(
  'governed client generation rejects an incompatible shared runtime dependency atomically',
  Effect.fn(function* mergedScenario44() {
    yield* withFixture(
      Effect.fn(function* mergedScenario43(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [scaffoldFlag.vertical, inventorySlug]);
        const packagePath = path.join(fixture.root, inventoryPackageFile);
        const packageJson = yield* decodeFixturePackage(yield* Effect.promise(() => readFile(packagePath, 'utf-8')));
        yield* Effect.promise(() =>
          writeFile(
            packagePath,
            json({
              ...packageJson,
              dependencies: {
                ...packageJson.dependencies,
                '@app/shared-contracts': '^1.0.0',
              },
            }),
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.moduleApi,
          [scaffoldFlag.vertical, inventorySlug, '--name', fixtureName.resourceDetail],
          /incompatible @app\/shared-contracts dependency/u,
        );
      }),
    );
  }),
);

it.live(
  'governed client generation restores its missing owner-local operation gateway',
  Effect.fn(function* mergedScenario47() {
    yield* withFixture(
      Effect.fn(function* mergedScenario46(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [scaffoldFlag.vertical, inventorySlug]);
        yield* Effect.promise(() => rm(path.join(fixture.root, inventoryActionGatewayFile)));

        yield* run(fixture, scaffoldCommand.moduleApi, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.resourceDetail,
        ]);

        const gateway = yield* readFixtureFile(fixture.root, inventoryActionGatewayFile);
        expect(gateway).toMatch(/@ontos-action-boundary-owner inventory-stock/u);
        expect(gateway).toMatch(/export const operationGateway = makeOperationGateway\(\)/u);
      }),
    );
  }),
);

it('recognizes only exact schema-only Outbox package subpaths as cross-vertical contracts', () => {
  const producerPackage = {
    exports: {
      '.': './src/index.ts',
      './outbox/orders-created': generatedOutboxContractPath,
      './workers': './src/workers/index.ts',
    },
  };
  expect(publishedOutboxContractExports(producerPackage)).toEqual(['./outbox/orders-created']);
  expect(() =>
    assertPublishedOutboxDependencyUsage({
      dependencyPackageJson: producerPackage,
      dependencyPackageName: inventoryPackageName,
      moduleSpecifiers: ['@app/inventory-stock/outbox/orders-created'],
    }),
  ).not.toThrow();
  expect(() =>
    assertPublishedOutboxDependencyUsage({
      dependencyPackageJson: producerPackage,
      dependencyPackageName: inventoryPackageName,
      moduleSpecifiers: ['@app/inventory-stock/workers'],
    }),
  ).toThrow(/not a published schema-only Outbox contract subpath/u);
  expect(() =>
    assertPublishedOutboxDependencyUsage({
      dependencyPackageJson: { exports: { '.': './src/index.ts' } },
      dependencyPackageName: inventoryPackageName,
      moduleSpecifiers: [inventoryPackageName],
    }),
  ).toThrow(/not a published schema-only Outbox contract dependency/u);
});

it.live(
  'rejects malformed command contracts and leaves the fixture unchanged',
  Effect.fn(function* scenario25() {
    yield* withFixture(
      Effect.fn(function* scenario26(fixture) {
        const before = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          runScaffoldEffect(
            'action',
            [
              scaffoldFlag.vertical,
              inventorySlug,
              '--action',
              fixtureName.action,
              scaffoldFlag.authorization,
              'action_execution',
              '--provisioning',
              'tenant_membership_default',
            ],
            { workspaceRoot: fixture.root },
          ).pipe(Effect.provide(NodeServices.layer)),
          (error) => expect(String(error)).toMatch(/missing required flag --legal-entity-scope/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
        const invalidCalls: readonly [ScaffoldCommand, readonly string[], RegExp][] = [
          ['action', [scaffoldFlag.vertical, inventorySlug], /missing required flag --action/u],
          [
            'action',
            [
              scaffoldFlag.vertical,
              inventorySlug,
              '--action',
              fixtureName.action,
              scaffoldFlag.legalEntityScope,
              'invalid',
            ],
            /must be required, optional, or forbidden/u,
          ],
          [
            'action',
            [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action, '--unknown', 'x'],
            /unknown flag --unknown/u,
          ],
          [
            'action',
            [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action, '--action', 'again'],
            /only once/u,
          ],
          ['action', [scaffoldFlag.vertical, '', '--action', fixtureName.action], /non-empty value/u],
          ['action', [scaffoldFlag.vertical, '../billing', '--action', fixtureName.action], /lower-kebab-case/u],
          ['action', [scaffoldFlag.vertical, '/absolute/billing', '--action', fixtureName.action], /lower-kebab-case/u],
          [
            'action',
            [
              scaffoldFlag.vertical,
              inventorySlug,
              '--scope',
              'core',
              '--module',
              fixtureName.actionModule,
              '--action',
              fixtureName.action,
            ],
            /mutually exclusive/u,
          ],
          ['action', ['--scope', 'core', '--action', fixtureName.action], /--module is required/u],
          [
            'action',
            ['--scope', 'other', '--module', fixtureName.actionModule, '--action', fixtureName.action],
            /--scope core is required/u,
          ],
          [
            'action',
            ['--scope', 'core', '--module', 'billing.modules', '--action', fixtureName.action],
            /stable lowercase core/u,
          ],
          [
            'action',
            ['--scope', 'core', '--module', 'core.../modules', '--action', fixtureName.action],
            /stable lowercase core/u,
          ],
          [
            'action',
            [scaffoldFlag.vertical, 'missing', '--action', fixtureName.action],
            /package metadata is missing/u,
          ],
          [
            scaffoldCommand.microverticalActionBoundary,
            [scaffoldFlag.vertical, inventorySlug, '--unknown', 'x'],
            /unknown flag --unknown/u,
          ],
          [scaffoldCommand.microverticalActionBoundary, [scaffoldFlag.vertical, '../billing'], /lower-kebab-case/u],
          [
            'policy',
            ['--scope', 'global', '--policy', fixtureName.policy, scaffoldFlag.vertical, inventorySlug],
            /forbidden/u,
          ],
          ['policy', ['--scope', 'microvertical', '--policy', fixtureName.policy], /required/u],
          ['policy', ['--scope', 'other', '--policy', fixtureName.policy], /global or microvertical/u],
          [
            scaffoldCommand.outboxMessage,
            [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action, '--topic', 'Not.Safe'],
            /dot-separated/u,
          ],
          [
            scaffoldCommand.outboxWorker,
            [
              scaffoldFlag.vertical,
              'billing',
              '--worker',
              fixtureName.ordersLogger,
              scaffoldFlag.producer,
              inventorySlug,
              '--topic',
              '../orders.created',
            ],
            /dot-separated/u,
          ],
        ];
        yield* Effect.all(
          invalidCalls.map(
            Effect.fn(function* scenario27([command, generatorArguments, expected]) {
              yield* expectFailure(run(fixture, command, generatorArguments), (error) =>
                expect(String(error)).toMatch(expected),
              );
              expect(yield* snapshotTree(fixture.root)).toEqual(before);
            }),
          ),
          { concurrency: 'unbounded' },
        );
      }),
    );
  }),
);

it.live(
  'generates one immutable Action identity boundary and exact direct dependencies',
  Effect.fn(function* mergedScenario50() {
    yield* withFixture(
      Effect.fn(function* mergedScenario49(fixture) {
        const shellBefore = yield* readFixtureFile(fixture.root, shellSentinelFile);
        const topologyBefore = yield* readFixtureFile(fixture.root, topologyFile);
        const result = yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [
          scaffoldFlag.vertical,
          inventorySlug,
        ]);
        expect(result.kind).toBe('generated');
        const server = yield* readFixtureFile(fixture.root, inventoryActionPrincipalFile);
        const actionHttpRunner = yield* readFixtureFile(fixture.root, inventoryActionHttpRunnerFile);
        const client = yield* readFixtureFile(fixture.root, inventoryActionGatewayFile);
        const redemption = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/api/auth/gateway-assertion-redemption.ts',
        );
        for (const source of [server, client]) {
          expect(source).toMatch(/@ontos-action-boundary-owner inventory-stock/u);
          expect(source).toMatch(/@ontos-action-boundary-audience inventory-stock/u);
          expect(source).toMatch(/ACTION_GATEWAY_AUDIENCE = 'inventory-stock'/u);
        }
        expect(server).toMatch(/@app\/gateway-principal-verifier\/server/u);
        expect(server).toMatch(/bindGatewayPrincipalVerifier\(ACTION_GATEWAY_AUDIENCE\)/u);
        expect(server).not.toMatch(/createLocalJWKSet|decodeProtectedHeader|jwtVerify|PublicVerificationKeySchema/u);
        expect(client).toMatch(/makeOperationGateway as makeSharedOperationGateway/u);
        expect(client).toMatch(/makeSharedOperationGateway\(ACTION_GATEWAY_AUDIENCE, acquire\)/u);
        expect(client).toMatch(/export const operationGateway = makeOperationGateway\(\)/u);
        expect(client).not.toMatch(/ActionGatewayIssuer|ActionGatewayAttempt|makeActionGateway|\bactionGateway\b/u);
        expect(client).not.toMatch(/Effect\.flatMap|Bearer \$\{|acquire\(\{ audience/u);
        expect(client).not.toMatch(
          /api\/auth\/action-principal|gateway-assertion-redemption|GatewayContextProtectedHeader|verticals\//u,
        );
        expect(client).not.toMatch(/localStorage|sessionStorage/u);
        expect(server).toMatch(/verifyAndRedeem/u);
        expect(actionHttpRunner).toMatch(/bindGovernedActionHttp/u);
        expect(actionHttpRunner).toMatch(/bindActionHttpRunner/u);
        expect(actionHttpRunner).toMatch(/authenticateOperationPrincipal/u);
        expect(actionHttpRunner).not.toMatch(/ActionRuntime|ActionCoreError|HttpApiEndpoint/u);
        expect(redemption).toMatch(/GatewayAssertionRedemptionUnavailableError/u);
        const packageJson = yield* decodeFixturePackage(yield* readFixtureFile(fixture.root, inventoryPackageFile));
        expect(packageJson.dependencies).toEqual({
          '@app/core-runtime': workspaceVersion,
          '@app/gateway-principal-verifier': workspaceVersion,
          '@app/shared-contracts': workspaceVersion,
          effect: '4.0.0-rc.112',
          zeta: '1.0.0',
        });
        expect(packageJson.scripts['existing']).toBe(preservedFixtureValue);
        expect(yield* readFixtureFile(fixture.root, shellSentinelFile)).toBe(shellBefore);
        expect(yield* readFixtureFile(fixture.root, topologyFile)).toBe(topologyBefore);
      }),
    );
  }),
);

it.live(
  'Action identity boundary preflight refuses unsafe writes',
  Effect.fn(function* scenario30() {
    yield* withFixture(
      Effect.fn(function* scenario31(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [scaffoldFlag.vertical, inventorySlug]);
        const afterFirstRun = yield* snapshotTree(fixture.root);
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [scaffoldFlag.vertical, inventorySlug]);
        expect(yield* snapshotTree(fixture.root)).toEqual(afterFirstRun);
      }),
    );
    yield* withFixture(
      Effect.fn(function* scenario32(fixture) {
        yield* write(
          fixture.root,
          inventoryActionPrincipalFile,
          `// Owner-authored identity adapter
export const ownerCode = true;
`,
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.microverticalActionBoundary,
          [scaffoldFlag.vertical, inventorySlug],
          /refusing to overwrite existing business file/u,
        );
      }),
    );
  }),
);

it.live(
  'governed generators reject legacy principal boundaries before writing files',
  Effect.fn(function* mergedScenario57() {
    yield* withFixture(
      Effect.fn(function* mergedScenario56(fixture) {
        yield* addInventoryItemResourceType(fixture);
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [scaffoldFlag.vertical, inventorySlug]);
        const generated = yield* readFixtureFile(fixture.root, inventoryActionPrincipalFile);
        const legacy = generated.replace(
          /const verifyOperationPrincipal =[\s\S]*$/u,
          'export const verifyOperationPrincipal = verifyActionPrincipal;\n',
        );
        expect(legacy).not.toMatch(/export const authenticateOperationPrincipal/u);
        yield* write(fixture.root, inventoryActionPrincipalFile, legacy);
        const before = yield* snapshotTree(fixture.root);
        const calls: readonly [ScaffoldCommand, readonly string[]][] = [
          [scaffoldCommand.microverticalActionBoundary, []],
          [scaffoldCommand.moduleApi, ['--name', fixtureName.resourceDetail]],
          [scaffoldCommand.searchProvider, ['--name', fixtureName.inventoryItems, scaffoldFlag.resource, 'item']],
          ['report', ['--name', fixtureName.stockLevels, scaffoldFlag.resource, 'item']],
        ];
        yield* Effect.all(
          calls.map(
            Effect.fn(function* mergedScenario55([command, args]) {
              yield* expectFailure(run(fixture, command, [scaffoldFlag.vertical, inventorySlug, ...args]), (error) =>
                expect(String(error)).toMatch(
                  /incompatible generated Action boundary:.*export authenticateOperationPrincipal.*provide ActionPrincipalVerifierLive|refusing to overwrite existing business file: operation boundary/u,
                ),
              );
              expect(yield* snapshotTree(fixture.root)).toEqual(before);
            }),
          ),
          { concurrency: 'unbounded' },
        );
      }),
    );
  }),
);

it.live(
  'governed generation preserves compatible owner principal adaptations',
  Effect.fn(function* preserveOwnerPrincipalAdaptations() {
    yield* withFixture(
      Effect.fn(function* preserveOwnerPrincipalFixture(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [scaffoldFlag.vertical, inventorySlug]);
        const adapted = `${yield* readFixtureFile(fixture.root, inventoryActionPrincipalFile)}\n// Owner-specific diagnostics remain private to this adapter.\n`;
        yield* write(fixture.root, inventoryActionPrincipalFile, adapted);
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [scaffoldFlag.vertical, inventorySlug]);
        yield* run(fixture, scaffoldCommand.moduleApi, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          fixtureName.resourceDetail,
        ]);
        expect(yield* readFixtureFile(fixture.root, inventoryActionPrincipalFile)).toBe(adapted);
      }),
    );
  }),
);

it.live(
  'generated verifier executes real Shell assertions and overlapping Ed25519 rotation',
  Effect.fn(function* mergedScenario68() {
    yield* withFixture(
      Effect.fn(function* mergedScenario67(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [scaffoldFlag.vertical, inventorySlug]);
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [scaffoldFlag.vertical, 'billing']);
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'node_modules', '@app'), {
            recursive: true,
          }),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime'),
            path.join(fixture.root, 'node_modules/@app/core-runtime'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, sharedContractsPackagePath),
            path.join(fixture.root, sharedContractsNodeModulePath),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/gateway-principal-verifier'),
            path.join(fixture.root, 'node_modules/@app/gateway-principal-verifier'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/node_modules/effect'),
            path.join(fixture.root, effectNodeModulePath),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'apps/shell-super-app/node_modules/jose'),
            path.join(fixture.root, 'node_modules/jose'),
            'dir',
          ),
        );
        const edgeBundleDirectory = path.join(fixture.root, 'edge-bundle');
        yield* Effect.promise(() => mkdir(edgeBundleDirectory, { recursive: true }));
        const edgeMetafile = path.join(edgeBundleDirectory, 'meta.json');
        const edgeBundle = spawnSync(
          esbuildPath,
          [
            path.join(fixture.root, inventoryActionPrincipalFile),
            '--bundle',
            '--format=esm',
            `--metafile=${edgeMetafile}`,
            `--outfile=${path.join(edgeBundleDirectory, 'action-principal.mjs')}`,
            '--platform=browser',
          ],
          { encoding: 'utf-8' },
        );
        const edgeBundleErrorMessage = edgeBundle.error?.message;
        let edgeBundleFailureMessage = 'edge bundle command did not start';
        if (edgeBundle.stderr.length > 0) {
          edgeBundleFailureMessage = edgeBundle.stderr;
        } else if (edgeBundleErrorMessage !== undefined && edgeBundleErrorMessage.length > 0) {
          edgeBundleFailureMessage = edgeBundleErrorMessage;
        }
        expect(edgeBundle.status, edgeBundleFailureMessage).toBe(0);
        const edgeInputs = Object.keys(
          (yield* Schema.decodeUnknownEffect(EsbuildMetafileSchema)(
            JSON.parse(yield* Effect.promise(() => readFile(edgeMetafile, 'utf-8'))),
          )).inputs,
        ).join('\n');
        expect(edgeInputs).toMatch(/core-runtime\/src\/auth\/gateway-assertion-redemption\.ts/u);
        expect(edgeInputs).not.toMatch(/core-runtime\/src\/db|node:(?:crypto|path)|\/pg\//u);
        const generatedModule = yield* Schema.decodeUnknownEffect(GeneratedPrincipalModuleSchema)(
          yield* Effect.promise(
            () => import(pathToFileURL(path.join(fixture.root, inventoryActionPrincipalFile)).href),
          ),
        );
        const billingGeneratedModule = yield* Schema.decodeUnknownEffect(GeneratedPrincipalModuleSchema)(
          yield* Effect.promise(
            () => import(pathToFileURL(path.join(fixture.root, 'verticals/billing/api/auth/action-principal.ts')).href),
          ),
        );
        const generatedClientModule = yield* Schema.decodeUnknownEffect(GeneratedOperationGatewayModuleSchema)(
          yield* Effect.promise(() => import(pathToFileURL(path.join(fixture.root, inventoryActionGatewayFile)).href)),
        );
        const generatedActionHttpRunnerModule = yield* Schema.decodeUnknownEffect(
          GeneratedActionHttpRunnerModuleSchema,
        )(
          yield* Effect.promise(
            () => import(pathToFileURL(path.join(fixture.root, inventoryActionHttpRunnerFile)).href),
          ),
        );
        const current = yield* makeGatewayKey('current');
        const retiring = yield* makeGatewayKey('retiring');
        const principal = {
          authBindingId: '30000000-0000-4000-8000-000000000001',
          authContextRef: 'better-auth-session:scaffold-test',
          authMethod: 'session' as const,
          principalId: '40000000-0000-4000-8000-000000000001',
          tenantId: '50000000-0000-4000-8000-000000000001',
        };
        const issue = Effect.fn(function* mergedScenario63(
          configuration: GatewayIssuerConfigValue,
          issuedAt: number,
          audience: string = inventorySlug,
        ) {
          return yield* issueGatewayContextAssertion({
            audience,
            principal,
          }).pipe(
            Effect.provide(
              makeGatewayIssuerLayer({
                currentTimeSeconds: Effect.succeed(issuedAt),
                generateJti: Effect.succeed(fixtureGatewayJti),
                loadAudiences: Effect.succeed(new Set([audience])),
                loadConfig: Effect.succeed(configuration),
              }),
            ),
          );
        });
        const environment = {
          ONTOS_GATEWAY_ISSUER: fixtureGatewayIssuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
            keys: [current.publicJwk, retiring.publicJwk],
          }),
        };
        const currentAssertion = yield* issue(current.configuration, 1_700_000_000);
        const billingAssertion = yield* issue(current.configuration, 1_700_000_000, 'billing');
        const retiringAssertion = yield* issue(retiring.configuration, 1_700_000_000);
        const testRedemption = { consume: () => Effect.void };
        const verify = (token: string, override: GeneratedPrincipalEnvironment = environment, now = 1_700_000_001) =>
          generatedModule.verifyActionPrincipal(`Bearer ${token}`, {
            currentTimeSeconds: Effect.succeed(now),
            environment: override,
            redemption: testRedemption,
          });

        expect(yield* verify(currentAssertion.token)).toEqual(principal);
        expect(
          yield* billingGeneratedModule.verifyActionPrincipal(`Bearer ${billingAssertion.token}`, {
            currentTimeSeconds: Effect.succeed(1_700_000_001),
            environment,
            redemption: testRedemption,
          }),
        ).toEqual(principal);
        yield* expectFailure(
          generatedModule.verifyActionPrincipal(`Bearer ${billingAssertion.token}`, {
            currentTimeSeconds: Effect.succeed(1_700_000_001),
            environment,
            redemption: testRedemption,
          }),
          (error) => expect(isGeneratedPrincipalError('ActionPrincipalScopeError')(error)).toBe(true),
        );
        yield* expectFailure(
          billingGeneratedModule.verifyActionPrincipal(`Bearer ${currentAssertion.token}`, {
            currentTimeSeconds: Effect.succeed(1_700_000_001),
            environment,
            redemption: testRedemption,
          }),
          (error) => expect(isGeneratedPrincipalError('ActionPrincipalScopeError')(error)).toBe(true),
        );
        expect(yield* verify(retiringAssertion.token)).toEqual(principal);
        yield* expectFailure(verify('not-a-jwt'), (error) =>
          expect(isGeneratedPrincipalError('ActionPrincipalInvalidError')(error)).toBe(true),
        );
        yield* Effect.all(
          [
            { keys: [] },
            { keys: [current.publicJwk, current.publicJwk] },
            { keys: [{ ...current.publicJwk, d: 'private-material' }] },
            { keys: [{ ...current.publicJwk, key_ops: ['sign'] }] },
            { keys: [{ ...current.publicJwk, alg: 'HS256' }] },
            { keys: [{ ...current.publicJwk, x: '' }] },
          ].map(
            Effect.fn(function* mergedScenario66(jwks) {
              return yield* expectFailure(
                verify(currentAssertion.token, {
                  ...environment,
                  ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify(jwks),
                }),
                (error) => expect(isGeneratedPrincipalError('ActionPrincipalConfigurationError')(error)).toBe(true),
              );
            }),
          ),
          { concurrency: 'unbounded' },
        );
        yield* expectFailure(
          verify(currentAssertion.token, {
            ...environment,
            ONTOS_GATEWAY_ISSUER: 'file:///not-an-http-issuer',
          }),
          (error) => expect(isGeneratedPrincipalError('ActionPrincipalConfigurationError')(error)).toBe(true),
        );
        yield* expectFailure(
          verify(
            retiringAssertion.token,
            {
              ...environment,
              ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                keys: [current.publicJwk],
              }),
            },
            1_700_000_000 + GATEWAY_ASSERTION_TTL_SECONDS + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS + 1,
          ),
          (error) => expect(isGeneratedPrincipalError('ActionPrincipalInvalidError')(error)).toBe(true),
        );
        const wrongAudience = yield* issue(current.configuration, 1_700_000_000, 'billing');
        yield* expectFailure(verify(wrongAudience.token), (error) =>
          expect(isGeneratedPrincipalError('ActionPrincipalScopeError')(error)).toBe(true),
        );
        const wrongIssuer = yield* issue(
          { ...current.configuration, issuer: 'https://other.example.test' },
          1_700_000_000,
        );
        yield* expectFailure(verify(wrongIssuer.token), (error) =>
          expect(isGeneratedPrincipalError('ActionPrincipalScopeError')(error)).toBe(true),
        );
        const unknownKid = yield* issue(
          {
            ...current.configuration,
            privateJwk: { ...current.configuration.privateJwk, kid: 'unknown' },
          },
          1_700_000_000,
        );
        yield* expectFailure(verify(unknownKid.token), (error) =>
          expect(isGeneratedPrincipalError('ActionPrincipalInvalidError')(error)).toBe(true),
        );
        const expired = yield* issue(current.configuration, 1_699_999_000);
        yield* expectFailure(verify(expired.token), (error) =>
          expect(isGeneratedPrincipalError('ActionPrincipalExpiredError')(error)).toBe(true),
        );
        const future = yield* issue(current.configuration, 1_700_000_032);
        yield* expectFailure(verify(future.token), (error) =>
          expect(isGeneratedPrincipalError('ActionPrincipalInvalidError')(error)).toBe(true),
        );
        const signingKey = yield* Effect.promise(() => importJWK(current.configuration.privateJwk, 'EdDSA'));
        const mismatchedSubject = yield* Effect.promise(() =>
          new SignJWT({ principal, ver: 1 })
            .setProtectedHeader({ alg: 'EdDSA', kid: 'current', typ: 'JWT' })
            .setIssuer(fixtureGatewayIssuer)
            .setAudience(inventorySlug)
            .setSubject('70000000-0000-4000-8000-000000000001')
            .setIssuedAt(1_700_000_000)
            .setExpirationTime(1_700_000_300)
            .setJti(fixtureGatewayJti)
            .sign(signingKey),
        );
        yield* expectFailure(verify(mismatchedSubject), (error) =>
          expect(isGeneratedPrincipalError('ActionPrincipalInvalidError')(error)).toBe(true),
        );
        const invalidContext = yield* Effect.promise(() =>
          new SignJWT({
            principal: { ...principal, principalId: 'not-a-uuid' },
            ver: 1,
          })
            .setProtectedHeader({ alg: 'EdDSA', kid: 'current', typ: 'JWT' })
            .setIssuer(fixtureGatewayIssuer)
            .setAudience(inventorySlug)
            .setSubject('not-a-uuid')
            .setIssuedAt(1_700_000_000)
            .setExpirationTime(1_700_000_300)
            .setJti(fixtureGatewayJti)
            .sign(signingKey),
        );
        yield* expectFailure(verify(invalidContext), (error) =>
          expect(isGeneratedPrincipalError('ActionPrincipalInvalidError')(error)).toBe(true),
        );
        const hmacSecret = yield* Effect.promise(() => generateSecret('HS256'));
        const hmacToken = yield* Effect.promise(() =>
          new SignJWT({ principal, ver: 1 })
            .setProtectedHeader({ alg: 'HS256', kid: 'current', typ: 'JWT' })
            .setIssuer(fixtureGatewayIssuer)
            .setAudience(inventorySlug)
            .setSubject(principal.principalId)
            .setIssuedAt(1_700_000_000)
            .setExpirationTime(1_700_000_300)
            .setJti(fixtureGatewayJti)
            .sign(hmacSecret),
        );
        yield* expectFailure(verify(hmacToken), (error) =>
          expect(isGeneratedPrincipalError('ActionPrincipalInvalidError')(error)).toBe(true),
        );
        const tokenParts = currentAssertion.token.split('.');
        const encodedPayload = tokenParts[1] ?? '';
        const tampered = `${tokenParts[0]}.${encodedPayload.startsWith('a') ? 'b' : 'a'}${encodedPayload.slice(1)}.${tokenParts[2]}`;
        yield* expectFailure(verify(tampered), (error) =>
          expect(isGeneratedPrincipalError('ActionPrincipalInvalidError')(error)).toBe(true),
        );
        yield* expectFailure(
          generatedModule.verifyActionPrincipal(undefined, {
            currentTimeSeconds: Effect.succeed(1_700_000_001),
            environment,
            redemption: testRedemption,
          }),
          (error) => expect(isGeneratedPrincipalError('ActionPrincipalMissingError')(error)).toBe(true),
        );
        yield* expectFailure(
          generatedModule.verifyActionPrincipal('bearer malformed', {
            currentTimeSeconds: Effect.succeed(1_700_000_001),
            environment,
            redemption: testRedemption,
          }),
          (error) => expect(isGeneratedPrincipalError('ActionPrincipalInvalidError')(error)).toBe(true),
        );
        yield* expectFailure(
          generatedModule.verifyActionPrincipal(`Bearer ${currentAssertion.token}`, {
            currentTimeSeconds: Effect.succeed(1_700_000_001),
            environment: {},
            redemption: testRedemption,
          }),
          (error) => expect(isGeneratedPrincipalError('ActionPrincipalConfigurationError')(error)).toBe(true),
        );
        let acquisitions = 0;
        const authorizations: string[] = [];
        const idempotencyKey = 'caller-owned-idempotency-key';
        const operationGateway = generatedClientModule.makeOperationGateway(({ audience }) => {
          acquisitions += 1;
          expect(audience).toBe(inventorySlug);
          return Effect.succeed({ token: `attempt-${acquisitions}` });
        });
        const attempt = (authorization: string) => {
          authorizations.push(authorization);
          return Effect.succeed(idempotencyKey);
        };
        expect(yield* operationGateway.invoke(attempt)).toBe(idempotencyKey);
        expect(yield* operationGateway.invoke(attempt)).toBe(idempotencyKey);
        expect(authorizations).toEqual(['Bearer attempt-1', 'Bearer attempt-2']);

        const actionApi = HttpApi.make('generatedActionIdentityFixture').add(
          HttpApiGroup.make('action').add(
            HttpApiEndpoint.post('invoke', '/actions/invoke', {
              error: [ActionAuthenticationProblemSchema, ActionVerificationUnavailableProblemSchema],
              success: TrustedPrincipalContextSchema,
            }),
          ),
        );
        let actionReached = false;
        let endpointEnvironment: GeneratedPrincipalEnvironment = environment;
        const markActionReached = Effect.sync(() => {
          actionReached = true;
        });
        const actionGroupLive = HttpApiBuilder.group(actionApi, 'action', (handlers) =>
          handlers.handle('invoke', ({ request }) =>
            generatedModule
              .verifyActionPrincipal(request.headers['authorization'], {
                currentTimeSeconds: Effect.succeed(1_700_000_001),
                environment: endpointEnvironment,
                redemption: testRedemption,
              })
              .pipe(Effect.tap(markActionReached), Effect.catchTags(generatedPrincipalErrorHandlers)),
          ),
        );
        const actionRuntime = defineEffectBff({
          api: actionApi,
          layer: HttpApiBuilder.layer(actionApi).pipe(Layer.provide(actionGroupLive)),
        });
        const actionHandler = actionRuntime.createHandler();
        yield* Effect.addFinalizer(() => Effect.promise(() => actionHandler.dispose()));
        const missingResponse = yield* Effect.promise(() =>
          actionHandler.handler(new Request(actionInvokeUrl, { method: 'POST' })),
        );
        expect(missingResponse.status).toBe(401);
        expect(missingResponse.headers.get('www-authenticate')).toBe('Bearer');
        expect(missingResponse.headers.get('content-type') ?? '').toMatch(/application\/problem\+json/u);
        expect(actionReached).toBe(false);
        endpointEnvironment = {};
        const unavailableResponse = yield* Effect.promise(() =>
          actionHandler.handler(
            new Request(actionInvokeUrl, {
              headers: { authorization: `Bearer ${currentAssertion.token}` },
              method: 'POST',
            }),
          ),
        );
        expect(unavailableResponse.status).toBe(503);
        expect(
          (yield* Schema.decodeUnknownEffect(RetryableProblemSchema)(
            yield* Effect.promise(() => unavailableResponse.json()),
          )).retryable,
        ).toBe(true);
        expect(actionReached).toBe(false);
        endpointEnvironment = environment;
        const successResponse = yield* Effect.promise(() =>
          actionHandler.handler(
            new Request(actionInvokeUrl, {
              headers: { authorization: `Bearer ${currentAssertion.token}` },
              method: 'POST',
            }),
          ),
        );
        expect(successResponse.status).toBe(200);
        expect(yield* Effect.promise(() => successResponse.json())).toEqual(principal);
        expect(actionReached).toBe(true);

        const generatedBindingApi = HttpApi.make('generatedActionRunnerFixture').add(
          HttpApiGroup.make('action').add(
            HttpApiEndpoint.post('invoke', '/actions/generated-runner', {
              error: [ActionAuthenticationProblemSchema, ActionVerificationUnavailableProblemSchema],
              success: GeneratedBindingResultSchema,
            }),
          ),
        );
        const runGeneratedActionHttp = generatedActionHttpRunnerModule.bindActionHttpRunner({
          authentication: actionAuthenticationProblem,
          unavailable: actionVerificationUnavailableProblem,
        });
        const harness = yield* makeActionTestHarness({
          actionPermission: 'allowed',
          tenantPermission: 'allowed',
        });
        const generatedBindingGroupLive = HttpApiBuilder.group(generatedBindingApi, 'action', (handlers) =>
          handlers.handle('invoke', ({ request }) =>
            runGeneratedActionHttp({
              endpointHeaders: {
                idempotencyKey: request.headers['idempotency-key'],
                traceId: 'generated-trace',
              },
              internalProblem: actionVerificationUnavailableProblem,
              invalidCorrelationProblem: actionAuthenticationProblem,
              mapError: actionVerificationUnavailableProblem,
              payload: {},
              registration: generatedBindingAction,
              requestHeaders: {
                authorization: Redacted.make(request.headers['authorization']),
                'x-correlation-id': request.headers['x-correlation-id'],
              },
            }),
          ),
        ).pipe(
          Layer.provide(generatedModule.ActionPrincipalVerifierLive),
          Layer.provide(Layer.succeed(GatewayAssertionRedemptionService, testRedemption)),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
          Layer.provide(harness.layer),
        );
        const generatedBindingRuntime = defineEffectBff({
          api: generatedBindingApi,
          layer: HttpApiBuilder.layer(generatedBindingApi).pipe(
            Layer.provide(generatedBindingGroupLive),
            Layer.provideMerge(harness.layer),
          ),
        });
        const generatedBindingHandler = generatedBindingRuntime.createHandler();
        yield* Effect.addFinalizer(() => Effect.promise(() => generatedBindingHandler.dispose()));
        const liveIssuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const liveAssertion = yield* issue(current.configuration, liveIssuedAt);
        const generatedBindingResponse = yield* Effect.promise(() =>
          generatedBindingHandler.handler(
            new Request('https://inventory.example.test/actions/generated-runner', {
              headers: {
                authorization: `Bearer ${liveAssertion.token}`,
                'x-correlation-id': 'generated-runner-correlation',
              },
              method: 'POST',
            }),
          ),
        );
        const generatedBindingBody = yield* Schema.decodeUnknownEffect(GeneratedBindingResultSchema)(
          yield* Effect.promise(() => generatedBindingResponse.json()),
        );
        expect(
          generatedBindingResponse.status,
          JSON.stringify({
            body: generatedBindingBody,
            snapshot: harness.snapshot(),
          }),
        ).toBe(200);
        expect(generatedBindingBody).toEqual({ accepted: true });
        expect(harness.snapshot().invocations.length).toBe(1);
        expect(harness.snapshot().transactionCount).toBe(1);
      }),
    );
  }),
);

it.live(
  'generates one self-contained typed fail-closed Action and preserves package metadata',
  Effect.fn(function* scenario38() {
    yield* withFixture(
      Effect.fn(function* scenario39(fixture) {
        yield* run(fixture, 'action', [scaffoldFlag.vertical, inventorySlug, '--action', 'create-order2']);
        const action = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/actions/create-order2.action.ts',
        );
        expect(action).toBe(`// @generated by OntOS Codesmith Action v1
// @ontos-action-owner inventory.stock
// @ontos-action-slug create-order2
import { Effect, Schema } from 'effect';
import { defineAction, defineTenantModuleEntrypoint } from '@app/core-runtime';

export const CreateOrder2PayloadSchema = Schema.Struct({});
export type CreateOrder2Payload = Schema.Schema.Type<typeof CreateOrder2PayloadSchema>;

export const CreateOrder2ResultSchema = Schema.Struct({});
export type CreateOrder2Result = Schema.Schema.Type<typeof CreateOrder2ResultSchema>;

export class CreateOrder2NotImplemented extends Schema.TaggedError<CreateOrder2NotImplemented>()(
  'CreateOrder2NotImplemented',
  {
    code: Schema.Literal('action_not_implemented'),
    reason: Schema.String,
  },
) {}

const handleCreateOrder2 = () =>
  Effect.fail(
    new CreateOrder2NotImplemented({
      code: 'action_not_implemented',
      reason: 'The Create Order2 Action is not implemented',
    }),
  );

export const createOrder2Action = defineAction(
  {
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'inventory.stock.create-order2.access.v1',
    },
    actionKey: 'inventory.stock.create-order2',
    auditProfile: 'standard',
    domainErrorSchema: CreateOrder2NotImplemented,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
      entrypointKey: 'inventory.stock.create-order2',
      moduleKey: 'inventory.stock',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: 'inventory.stock',
    payloadSchema: CreateOrder2PayloadSchema,
    policies: [],
    resultSchema: CreateOrder2ResultSchema,
    schemaVersion: '1',
  },
  handleCreateOrder2,
);

// <generated-outbox-message-exports>
// </generated-outbox-message-exports>
`);
        const packageJson = yield* decodeFixturePackage(yield* readFixtureFile(fixture.root, inventoryPackageFile));
        expect(packageJson.dependencies).toEqual({
          '@app/core-runtime': workspaceVersion,
          zeta: '1.0.0',
        });
        expect(packageJson.scripts['existing']).toBe(preservedFixtureValue);
        yield* assertScaffoldRefused(
          fixture,
          'action',
          [scaffoldFlag.vertical, inventorySlug, '--action', 'create-order2'],
          /refusing to overwrite/u,
        );
      }),
    );
  }),
);

it.live(
  'generates an owner-local Action service without overwriting business logic',
  Effect.fn(function* scenario40() {
    yield* withFixture(
      Effect.fn(function* scenario41(fixture) {
        yield* run(fixture, scaffoldCommand.actionService, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--service',
          'inventory-persistence',
        ]);
        const service = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/services/inventory-persistence.service.ts',
        );
        expect(service).toBe(`// @generated by OntOS Codesmith Action Service v1
import { Effect } from 'effect';

export const inventoryPersistenceService = () => Effect.succeed({});
`);
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.actionService,
          [scaffoldFlag.vertical, inventorySlug, '--service', 'inventory-persistence'],
          /refusing to overwrite/u,
        );
      }),
    );
  }),
);

it.live(
  'generates exactly one private owner-local external HTTP adapter',
  Effect.fn(function* scenario42() {
    yield* withFixture(
      Effect.fn(function* scenario43(fixture) {
        const before = yield* snapshotTree(fixture.root);
        const result = yield* run(fixture, scaffoldCommand.externalHttpAdapter, [
          scaffoldFlag.vertical,
          'contacts',
          scaffoldFlag.provider,
          'ares',
          scaffoldFlag.operation,
          'subject',
        ]);
        const adapterPath = path.join(fixture.root, 'verticals/contacts/src/integrations/ares/ares-subject.service.ts');
        expect(result).toEqual({
          kind: 'generated',
          result: { adapterPath },
        });
        const after = yield* snapshotTree(fixture.root);
        const changedPaths = new Set([
          ...Object.keys(before).filter((file) => before[file] !== after[file]),
          ...Object.keys(after).filter((file) => before[file] !== after[file]),
        ]);
        expect([...changedPaths]).toEqual(['verticals/contacts/src/integrations/ares/ares-subject.service.ts']);
        expect(after['verticals/contacts/src/integrations/ares/ares-subject.service.ts'])
          .toBe(`// @generated by OntOS Codesmith External HTTP Adapter v1
import { Context, Effect, Layer, Schema } from 'effect';
import { HttpClient } from 'effect/unstable/http';

export class AresSubjectNotImplemented extends Schema.TaggedError<AresSubjectNotImplemented>()(
  'AresSubjectNotImplemented',
  {
    code: Schema.Literal('external_http_adapter_not_implemented'),
    reason: Schema.String,
  },
) {}

export interface AresSubjectServiceContract {
  readonly subject: () => Effect.Effect<never, AresSubjectNotImplemented>;
}

export class AresSubjectService extends Context.Service<AresSubjectService, AresSubjectServiceContract>()(
  '@app/contacts/integrations/ares/ares-subject/AresSubjectService',
) {}

const makeAresSubjectService = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  return {
    subject: () => {
      void httpClient;
      return Effect.fail(
        new AresSubjectNotImplemented({
          code: 'external_http_adapter_not_implemented',
          reason: 'The Ares Subject external HTTP adapter is not implemented',
        }),
      );
    },
  } satisfies AresSubjectServiceContract;
});

export const AresSubjectServiceLive = Layer.effect(AresSubjectService, makeAresSubjectService);
`);
        const source = after['verticals/contacts/src/integrations/ares/ares-subject.service.ts'] ?? '';
        expect(source).toMatch(/HttpClient\.HttpClient/u);
        expect(source).toMatch(/Layer\.effect/u);
        expect(source).not.toMatch(
          /fetch\(|httpClient\.(?:execute|get|head|post|patch|put|del|options)\(|https?:\/\//u,
        );

        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.externalHttpAdapter,
          [scaffoldFlag.vertical, 'contacts', scaffoldFlag.provider, 'ares', scaffoldFlag.operation, 'subject'],
          /refusing to overwrite/u,
        );
      }),
    );
  }),
);

it.live(
  'rejects unsafe external HTTP adapter command input without writing',
  Effect.fn(function* scenario44() {
    yield* withFixture(
      Effect.fn(function* scenario45(fixture) {
        const before = yield* snapshotTree(fixture.root);
        const invalidCalls: readonly [readonly string[], RegExp][] = [
          [[scaffoldFlag.vertical, 'contacts', scaffoldFlag.operation, 'subject'], /missing required flag --provider/u],
          [[scaffoldFlag.vertical, 'contacts', scaffoldFlag.provider, 'ares'], /missing required flag --operation/u],
          [[scaffoldFlag.provider, 'ares', scaffoldFlag.operation, 'subject'], /missing required flag --vertical/u],
          [
            [
              scaffoldFlag.vertical,
              'contacts',
              scaffoldFlag.provider,
              'ares',
              scaffoldFlag.operation,
              'subject',
              '--unknown',
              'x',
            ],
            /unknown flag --unknown/u,
          ],
          [
            [
              scaffoldFlag.vertical,
              'contacts',
              scaffoldFlag.provider,
              'ares',
              scaffoldFlag.provider,
              'other',
              scaffoldFlag.operation,
              'subject',
            ],
            /only once/u,
          ],
          [
            [scaffoldFlag.vertical, 'contacts', scaffoldFlag.provider, 'Ares', scaffoldFlag.operation, 'subject'],
            /provider must be canonical lower-kebab-case/u,
          ],
          [
            [scaffoldFlag.vertical, 'contacts', scaffoldFlag.provider, 'ares', scaffoldFlag.operation, 'Subject'],
            /operation must be canonical lower-kebab-case/u,
          ],
          [
            [scaffoldFlag.vertical, 'contacts', scaffoldFlag.provider, 'src', scaffoldFlag.operation, 'subject'],
            /provider must be canonical lower-kebab-case/u,
          ],
          [
            [scaffoldFlag.vertical, 'contacts', scaffoldFlag.provider, 'ares', scaffoldFlag.operation, 'node_modules'],
            /operation must be canonical lower-kebab-case/u,
          ],
          [
            [scaffoldFlag.vertical, 'contacts', scaffoldFlag.provider, '../ares', scaffoldFlag.operation, 'subject'],
            /provider must be canonical lower-kebab-case/u,
          ],
          [
            [scaffoldFlag.vertical, 'contacts', scaffoldFlag.provider, 'ares', scaffoldFlag.operation, '../subject'],
            /operation must be canonical lower-kebab-case/u,
          ],
          [
            [scaffoldFlag.vertical, 'missing', scaffoldFlag.provider, 'ares', scaffoldFlag.operation, 'subject'],
            /package metadata is missing/u,
          ],
        ];
        for (const [generatorArguments, expected] of invalidCalls) {
          yield* expectFailure(run(fixture, scaffoldCommand.externalHttpAdapter, generatorArguments), (error) =>
            expect(String(error)).toMatch(expected),
          );
          expect(yield* snapshotTree(fixture.root)).toEqual(before);
        }
      }),
    );
  }),
);

it.live(
  'external HTTP adapter planner rejects malformed OntOS ownership atomically',
  Effect.fn(function* scenario47() {
    yield* withFixture(
      Effect.fn(function* scenario48(fixture) {
        const manifestPath = path.join(fixture.root, 'verticals/contacts/vertical.manifest.ts');
        const manifest = yield* Effect.promise(() => readFile(manifestPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(
            manifestPath,
            manifest.replace('// @generated by OntOS Codesmith Module Contract v1', '// developer-owned manifest'),
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.externalHttpAdapter,
          [scaffoldFlag.vertical, 'contacts', scaffoldFlag.provider, 'ares', scaffoldFlag.operation, 'subject'],
          /is not a generated module owner/u,
        );
      }),
    );

    yield* withFixture(
      Effect.fn(function* scenario49(fixture) {
        yield* write(
          fixture.root,
          'verticals/contacts/src/integrations',
          'planner fixture blocks the required directory\n',
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.externalHttpAdapter,
          [scaffoldFlag.vertical, 'contacts', scaffoldFlag.provider, 'ares', scaffoldFlag.operation, 'subject'],
          /ENOTDIR|not a directory/u,
        );
      }),
    );
  }),
);

it.live(
  'Action generation rejects unrelated imports in its governed owner slots',
  Effect.fn(function* scenario50() {
    yield* withFixture(
      Effect.fn(function* scenario51(fixture) {
        const manifestPath = path.join(fixture.root, inventoryManifestFile);
        const manifest = yield* Effect.promise(() => readFile(manifestPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(
            manifestPath,
            manifest.replace(
              '// <generated-module-manifest-imports>',
              `// <generated-module-manifest-imports>
import { fakeRead } from './src/api/fake.read.ts';`,
            ),
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          'action',
          [scaffoldFlag.vertical, inventorySlug, '--action', 'create-order3'],
          /generated owner slot contains unsupported developer content/u,
        );
      }),
    );
  }),
);

it.live(
  'generates Core-owned Actions only through the Core owner slot with atomic preflight',
  Effect.fn(function* scenario52() {
    yield* withFixture(
      Effect.fn(function* scenario53(fixture) {
        yield* run(fixture, 'action', [
          '--scope',
          'core',
          '--module',
          fixtureName.actionModule,
          '--action',
          'z-last-change',
        ]);
        yield* run(fixture, 'action', [
          '--scope',
          'core',
          '--module',
          fixtureName.actionModule,
          '--action',
          'account-change',
        ]);

        const action = yield* readFixtureFile(
          fixture.root,
          'packages/core-runtime/src/modules/actions/account-change.action.ts',
        );
        expect(action).toMatch(/@ontos-action-owner core\.modules/u);
        expect(action).toMatch(/actionKey: 'core\.modules\.account-change'/u);
        expect(action).toMatch(/entrypoint: defineSystemModuleEntrypoint\(\{/u);
        expect(action).toMatch(/access: 'write'/u);
        expect(action).toMatch(/role: 'action'/u);
        expect(action).toMatch(/from '\.\.\/\.\.\/actions\/definition\.ts'/u);
        expect(action).not.toMatch(/verticals|fetch\(/u);

        const coreIndex = yield* readFixtureFile(fixture.root, coreRuntimeIndexFile);
        const accountExport = "export { accountChangeAction } from './modules/actions/account-change.action.ts';";
        const zExport = "export { zLastChangeAction } from './modules/actions/z-last-change.action.ts';";
        expect(coreIndex.includes(accountExport)).toBe(true);
        expect(coreIndex.includes(zExport)).toBe(true);
        expect(coreIndex.indexOf(accountExport) < coreIndex.indexOf(zExport)).toBe(true);
        expect(coreIndex).toMatch(/export const existingCoreSurface = true/u);

        const coreCatalog = yield* readFixtureFile(fixture.root, coreActionCatalogFile);
        const accountImport = "import { accountChangeAction } from './account-change.action.ts';";
        const zImport = "import { zLastChangeAction } from './z-last-change.action.ts';";
        expect(coreCatalog.includes(accountImport)).toBe(true);
        expect(coreCatalog.includes(zImport)).toBe(true);
        expect(coreCatalog.includes('accountChangeAction.descriptor,')).toBe(true);
        expect(coreCatalog.includes('zLastChangeAction.descriptor,')).toBe(true);
        expect(coreCatalog.indexOf(accountImport) < coreCatalog.indexOf(zImport)).toBe(true);
        expect(
          coreCatalog.indexOf('accountChangeAction.descriptor,') < coreCatalog.indexOf('zLastChangeAction.descriptor,'),
        ).toBe(true);
        expect(coreCatalog).toMatch(/export const existingCatalogSurface = true/u);

        yield* assertScaffoldRefused(
          fixture,
          'action',
          ['--scope', 'core', '--module', fixtureName.actionModule, '--action', 'account-change'],
          /refusing to overwrite/u,
        );
      }),
    );

    yield* withFixture(
      Effect.fn(function* scenario54(fixture) {
        const indexPath = path.join(fixture.root, coreRuntimeIndexFile);
        yield* Effect.promise(() =>
          writeFile(
            indexPath,
            `export const existingCoreSurface = true;\n\n// <generated-global-policy-exports>\n// </generated-global-policy-exports>\n`,
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          'action',
          ['--scope', 'core', '--module', fixtureName.actionModule, '--action', fixtureName.action],
          /generated owner file does not contain one valid/u,
        );
      }),
    );

    yield* withFixture(
      Effect.fn(function* scenario55(fixture) {
        const indexPath = path.join(fixture.root, coreRuntimeIndexFile);
        const index = yield* Effect.promise(() => readFile(indexPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(
            indexPath,
            index.replace(
              '// <generated-core-action-exports>\n',
              '// <generated-core-action-exports>\nexport const developerOwned = true;\n',
            ),
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          'action',
          ['--scope', 'core', '--module', fixtureName.actionModule, '--action', fixtureName.action],
          /unsupported developer content/u,
        );
      }),
    );

    yield* withFixture(
      Effect.fn(function* scenario56(fixture) {
        const catalogPath = path.join(fixture.root, coreActionCatalogFile);
        const catalog = yield* Effect.promise(() => readFile(catalogPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(
            catalogPath,
            catalog.replace(
              '// <generated-core-action-catalog-values>\n',
              '// <generated-core-action-catalog-values>\n  developerOwned.descriptor,\n',
            ),
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          'action',
          ['--scope', 'core', '--module', fixtureName.actionModule, '--action', fixtureName.action],
          /unsupported developer content/u,
        );
      }),
    );
  }),
);

it.live(
  'preflights the Action dependency patch before creating a file',
  Effect.fn(function* scenario57() {
    yield* withFixture(
      Effect.fn(function* scenario58(fixture) {
        const packagePath = path.join(fixture.root, inventoryPackageFile);
        const packageJson = yield* decodeFixturePackage(yield* Effect.promise(() => readFile(packagePath, 'utf-8')));
        yield* Effect.promise(() =>
          writeFile(
            packagePath,
            json({
              ...packageJson,
              dependencies: { '@app/core-runtime': '^1.0.0', zeta: '1.0.0' },
            }),
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          'action',
          [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action],
          /incompatible/u,
        );
      }),
    );
  }),
);

it.live(
  'rejects Action generation when a vertical app identity is duplicated',
  Effect.fn(function* scenario59() {
    yield* withFixture(
      Effect.fn(function* scenario60(fixture) {
        const billingPackagePath = path.join(fixture.root, 'verticals/billing/package.json');
        const billingPackage = yield* decodeFixturePackage(
          yield* Effect.promise(() => readFile(billingPackagePath, 'utf-8')),
        );
        yield* Effect.promise(() =>
          writeFile(
            billingPackagePath,
            json({
              ...billingPackage,
              modernjs: {
                ...billingPackage.modernjs,
                appId: inventoryVertical.appId,
              },
            }),
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          'action',
          [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action],
          /duplicate generated appId inventory-stock/u,
        );
      }),
    );
  }),
);

it.live(
  'rejects Action generation when the target identity is absent from topology',
  Effect.fn(function* scenario61() {
    yield* withFixture(
      Effect.fn(function* scenario62(fixture) {
        const packagePath = path.join(fixture.root, inventoryPackageFile);
        const packageJson = yield* decodeFixturePackage(yield* Effect.promise(() => readFile(packagePath, 'utf-8')));
        yield* Effect.promise(() =>
          writeFile(
            packagePath,
            json({
              ...packageJson,
              modernjs: { ...packageJson.modernjs, appId: 'inventory-shadow' },
            }),
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          'action',
          [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action],
          /must have exactly one matching generated topology entry/u,
        );
      }),
    );
  }),
);

it.live(
  'preserves owner JSON document style while patching the Core dependency',
  Effect.fn(function* scenario63() {
    yield* withFixture(
      Effect.fn(function* scenario64(fixture) {
        const packagePath = path.join(fixture.root, inventoryPackageFile);
        const packageJson = yield* decodeFixturePackage(yield* Effect.promise(() => readFile(packagePath, 'utf-8')));
        const styledPackage = JSON.stringify(packageJson, null, 4).replaceAll('\n', '\r\n');
        yield* Effect.promise(() => writeFile(packagePath, styledPackage, 'utf-8'));

        yield* run(fixture, 'action', [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action]);

        const patched = yield* Effect.promise(() => readFile(packagePath, 'utf-8'));
        expect(patched).toMatch(/\r\n {4}"dependencies": \{\r\n/u);
        expect(patched).toMatch(/\r\n {8}"existing": "preserve-me"/u);
        expect(patched).not.toMatch(/(?<!\r)\n/u);
        expect(patched.endsWith('\r\n')).toBe(false);
      }),
    );
  }),
);

it.live(
  'generates Action-owned Outbox Messages and sorts only the owned export slot',
  Effect.fn(function* scenario65() {
    yield* withFixture(
      Effect.fn(function* scenario66(fixture) {
        yield* run(fixture, 'action', [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action]);
        const actionPath = path.join(fixture.root, inventoryActionFile);
        const generatedAction = yield* Effect.promise(() => readFile(actionPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(actionPath, `${generatedAction}\nexport const developerOwned = true;\n`, 'utf-8'),
        );
        yield* run(fixture, scaffoldCommand.outboxMessage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
          '--topic',
          fixtureName.ordersShipped,
        ]);
        yield* run(fixture, scaffoldCommand.outboxMessage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
          '--topic',
          fixtureName.ordersCreated,
        ]);
        const message = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/actions/create-order.orders-created.outbox-message.ts',
        );
        expect(message).toBe(`import type { OutboxMessage } from '@app/core-runtime';
import { OutboxPayloadSchema, outboxProducerModuleKey, outboxTopic } from '@app/inventory-stock/outbox/orders-created';
import type { OutboxPayload } from '@app/inventory-stock/outbox/orders-created';

export const CreateOrderOrdersCreatedOutboxPayloadSchema = OutboxPayloadSchema;
export type CreateOrderOrdersCreatedOutboxPayload = OutboxPayload;
export const CreateOrderOrdersCreatedOutboxProducerModuleKey = outboxProducerModuleKey;
export const CreateOrderOrdersCreatedOutboxTopic = outboxTopic;

export const createCreateOrderOrdersCreatedOutboxMessage = (payload: OutboxPayload): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: CreateOrderOrdersCreatedOutboxProducerModuleKey,
  topic: CreateOrderOrdersCreatedOutboxTopic,
});
`);
        expect(yield* readFixtureFile(fixture.root, inventoryOutboxContractFile))
          .toBe(`// @generated by OntOS Codesmith Outbox Message Contract v1
// @ontos-outbox-producer inventory.stock
// @ontos-outbox-topic orders.created
import { Schema } from 'effect';

export const OutboxPayloadSchema = Schema.Struct({
  data: Schema.Json,
});
export type OutboxPayload = Schema.Schema.Type<typeof OutboxPayloadSchema>;

export const outboxTopic = 'orders.created' as const;
export const outboxProducerModuleKey = 'inventory.stock' as const;
`);
        const producerPackage = yield* decodeFixturePackage(yield* readFixtureFile(fixture.root, inventoryPackageFile));
        expect(producerPackage.exports['./outbox/orders-created']).toBe(generatedOutboxContractPath);
        const action = yield* Effect.promise(() => readFile(actionPath, 'utf-8'));
        const createdExport =
          "export { CreateOrderOrdersCreatedOutboxPayloadSchema } from './create-order.orders-created.outbox-message.ts';";
        const shippedExport =
          "export { CreateOrderOrdersShippedOutboxPayloadSchema } from './create-order.orders-shipped.outbox-message.ts';";
        expect(action.indexOf(createdExport) < action.indexOf(shippedExport)).toBe(true);
        expect(action).toMatch(/export const developerOwned = true;/u);
        expect(message).not.toMatch(/addDomainEvent|addOutboxMessage|subjectResource|transport|worker/u);

        yield* run(fixture, scaffoldCommand.outboxMessage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
          '--topic',
          'events.foo-1-bar',
        ]);
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.outboxMessage,
          [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action, '--topic', 'events.foo1-bar'],
          /Outbox identifier CreateOrderEventsFoo1BarOutbox already exists/u,
        );
      }),
    );
  }),
);

it.live(
  'rejects missing, handwritten, duplicate, and normalized-collision Outbox targets without partial writes',
  Effect.fn(function* scenario67() {
    yield* withFixture(
      Effect.fn(function* scenario68(fixture) {
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.outboxMessage,
          [scaffoldFlag.vertical, inventorySlug, '--action', 'missing-action', '--topic', fixtureName.ordersCreated],
          /requires the generated Action/u,
        );

        yield* write(
          fixture.root,
          'verticals/inventory-stock/src/actions/handwritten.action.ts',
          `// <generated-outbox-message-exports>\n// </generated-outbox-message-exports>\n`,
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.outboxMessage,
          [scaffoldFlag.vertical, inventorySlug, '--action', 'handwritten', '--topic', fixtureName.ordersCreated],
          /only the matching generated Action/u,
        );

        yield* run(fixture, 'action', [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action]);
        const governedActionPath = inventoryActionFile;
        const governedAction = yield* readFixtureFile(fixture.root, governedActionPath);
        yield* write(
          fixture.root,
          governedActionPath,
          governedAction.replace("      access: 'write',", "      access: 'read',"),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.outboxMessage,
          [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action, '--topic', fixtureName.ordersCreated],
          /matching generated Action with its governed write entrypoint/u,
        );
        yield* write(fixture.root, governedActionPath, governedAction);
        yield* run(fixture, scaffoldCommand.outboxMessage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
          '--topic',
          'orders.created-v2',
        ]);
        const beforeCollision = yield* snapshotTree(fixture.root);
        yield* Effect.all(
          ['orders.created-v2', 'orders-created.v2'].map(
            Effect.fn(function* scenario69(topic) {
              yield* expectFailure(
                run(fixture, scaffoldCommand.outboxMessage, [
                  scaffoldFlag.vertical,
                  inventorySlug,
                  '--action',
                  fixtureName.action,
                  '--topic',
                  topic,
                ]),
                (error) => expect(String(error)).toMatch(/already exists/u),
              );
              expect(yield* snapshotTree(fixture.root)).toEqual(beforeCollision);
            }),
          ),
          { concurrency: 'unbounded' },
        );
      }),
    );
  }),
);

it.live(
  'generates isolated Outbox Workers from published contracts and composes a stable registry',
  Effect.fn(function* mergedScenario71() {
    yield* withFixture(
      Effect.fn(function* mergedScenario70(fixture) {
        const billingApiBefore = yield* readFixtureFile(fixture.root, billingApiIndexFile);
        yield* run(fixture, 'action', [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action]);
        yield* run(fixture, scaffoldCommand.outboxMessage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
          '--topic',
          fixtureName.ordersCreated,
        ]);
        const producerBefore = Object.fromEntries(
          Object.entries(yield* snapshotTree(fixture.root)).filter(([file]) =>
            file.startsWith('verticals/inventory-stock/'),
          ),
        );

        yield* run(fixture, scaffoldCommand.outboxWorker, [
          scaffoldFlag.vertical,
          'billing',
          '--worker',
          fixtureName.ordersCreatedLogger,
          scaffoldFlag.producer,
          inventorySlug,
          '--topic',
          fixtureName.ordersCreated,
        ]);
        const worker = yield* readFixtureFile(
          fixture.root,
          'verticals/billing/src/workers/orders-created-logger.worker.ts',
        );
        expect(worker).toBe(`// @generated by OntOS Codesmith Outbox Worker v1
// @ontos-outbox-worker-key billing.core.orders-created-logger
// @ontos-outbox-worker-owner billing.core
// @ontos-outbox-worker-producer inventory.stock
// @ontos-outbox-worker-topic orders.created
import { Effect, Schema } from 'effect';
import { defineOutboxWorker, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { OutboxPayloadSchema, outboxProducerModuleKey, outboxTopic } from '@app/inventory-stock/outbox/orders-created';

export class OrdersCreatedLoggerNotImplemented extends Schema.TaggedError<OrdersCreatedLoggerNotImplemented>()(
  'OrdersCreatedLoggerNotImplemented',
  {
    code: Schema.Literal('outbox_worker_not_implemented'),
    reason: Schema.String,
  },
) {}

const handleOrdersCreatedLogger = () =>
  Effect.fail(
    new OrdersCreatedLoggerNotImplemented({
      code: 'outbox_worker_not_implemented',
      reason: 'The OrdersCreatedLogger Outbox Worker is not implemented',
    }),
  );

export const ordersCreatedLoggerWorker = defineOutboxWorker(
  {
    consumerModuleKey: 'billing.core',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      authorization: { kind: 'owner_local_background' },
      entrypointKey: 'billing.core.orders-created-logger',
      moduleKey: 'billing.core',
      role: 'worker',
    }),
    leaseDurationMs: 30_000,
    payloadSchema: OutboxPayloadSchema,
    producerModuleKey: outboxProducerModuleKey,
    retryPolicy: {
      initialBackoffMs: 1000,
      maxAttempts: 5,
      maxBackoffMs: 60_000,
      multiplier: 2,
    },
    topic: outboxTopic,
    workerKey: 'billing.core.orders-created-logger',
  },
  handleOrdersCreatedLogger,
);
`);
        expect(yield* readFixtureFile(fixture.root, billingWorkersIndexFile))
          .toBe(`import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { ordersCreatedLoggerWorker } from './orders-created-logger.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  ordersCreatedLoggerWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
`);
        expect(yield* readFixtureFile(fixture.root, 'verticals/billing/src/worker-host/layer.ts'))
          .toBe(`// @generated by scaffold:outbox-worker worker-host
// @ontos-outbox-worker-host-owner billing.core
import { Layer } from 'effect';
import { OutboxWorkerInfrastructureLive } from '@app/core-runtime/outbox/worker';

export { CorePersistenceLive as outboxWorkerCorePersistenceLive } from '@app/core-runtime/outbox/worker';
export { DatabaseConfigLive as outboxWorkerDatabaseConfigLive } from '@app/core-runtime/outbox/worker';
export { OutboxRepositoryLive as outboxWorkerRepositoryLive } from '@app/core-runtime/outbox/worker';

/** Add owner-local repositories and services required by worker handlers here. */
const outboxWorkerHandlerLayer = Layer.empty;

export const outboxWorkerLayer = Layer.merge(OutboxWorkerInfrastructureLive, outboxWorkerHandlerLayer);
`);
        expect(yield* readFixtureFile(fixture.root, 'verticals/billing/src/worker-host/main.ts'))
          .toBe(`// @generated by scaffold:outbox-worker worker-host
// @ontos-outbox-worker-host-owner billing.core
import { startBillingOutboxWorker } from '../../scripts/outbox-worker.ts';

startBillingOutboxWorker();
`);
        expect(yield* readFixtureFile(fixture.root, 'verticals/billing/scripts/outbox-worker.ts'))
          .toBe(`// @generated by scaffold:outbox-worker worker-host
// @ontos-outbox-worker-host-owner billing.core
import { Layer } from 'effect';
import { extractOutboxWorkerSubscriptions, startOutboxWorkerProcess } from '@app/core-runtime/outbox/worker';
import { outboxWorkers } from '../src/workers/index.ts';
import {
  outboxWorkerCorePersistenceLive,
  outboxWorkerDatabaseConfigLive,
  outboxWorkerLayer as outboxWorkerDefinitionLayer,
  outboxWorkerRepositoryLive,
} from '../src/worker-host/layer.ts';

const outboxSubscriptions = extractOutboxWorkerSubscriptions(outboxWorkers);
const outboxWorkerProcessLayer = outboxWorkerDefinitionLayer.pipe(
  Layer.provide(outboxWorkerRepositoryLive),
  Layer.provide(outboxWorkerCorePersistenceLive),
  Layer.provide(outboxWorkerDatabaseConfigLive),
);

export const startBillingOutboxWorker = (): void =>
  startOutboxWorkerProcess({
    claimOwnerPrefix: 'billing.core-outbox-worker',
    health: true,
    layer: outboxWorkerProcessLayer,
    registrations: outboxWorkers,
    subscriptions: outboxSubscriptions,
  });
`);
        expect(yield* readFixtureFile(fixture.root, billingApiIndexFile)).toBe(billingApiBefore);
        const consumerPackage = yield* decodeFixturePackage(
          yield* readFixtureFile(fixture.root, 'verticals/billing/package.json'),
        );
        expect(consumerPackage.dependencies['@app/core-runtime']).toBe(workspaceVersion);
        expect(consumerPackage.dependencies[inventoryPackageName]).toBe(workspaceVersion);
        expect(consumerPackage.exports['./workers']).toBe(undefined);
        expect(consumerPackage.scripts['dev:worker']).toBe(workerStartScript);
        expect(consumerPackage.scripts['worker:start']).toBe(workerStartScript);
        const consumerTsconfig = yield* Schema.decodeUnknownEffect(FixtureTsconfigSchema)(
          JSON.parse(yield* readFixtureFile(fixture.root, 'verticals/billing/tsconfig.json')),
        );
        expect(consumerTsconfig.references).toEqual([{ path: '../inventory-stock' }]);
        const producerAfter = Object.fromEntries(
          Object.entries(yield* snapshotTree(fixture.root)).filter(([file]) =>
            file.startsWith('verticals/inventory-stock/'),
          ),
        );
        expect(producerAfter).toEqual(producerBefore);

        yield* run(fixture, scaffoldCommand.outboxMessage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
          '--topic',
          fixtureName.ordersShipped,
        ]);
        yield* run(fixture, scaffoldCommand.outboxWorker, [
          scaffoldFlag.vertical,
          'billing',
          '--worker',
          'orders-shipped-projector',
          scaffoldFlag.producer,
          inventorySlug,
          '--topic',
          fixtureName.ordersShipped,
        ]);
        const registry = yield* readFixtureFile(fixture.root, billingWorkersIndexFile);
        expect(
          registry.indexOf('ordersCreatedLoggerWorker') < registry.indexOf('ordersShippedProjectorWorker'),
        ).toBeTruthy();
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.outboxWorker,
          [
            scaffoldFlag.vertical,
            'billing',
            '--worker',
            fixtureName.ordersCreatedLogger,
            scaffoldFlag.producer,
            inventorySlug,
            '--topic',
            fixtureName.ordersCreated,
          ],
          /refusing to overwrite/u,
        );
      }),
    );
  }),
);

it.live(
  'generates self-consuming Outbox Workers without circular project or package dependencies',
  Effect.fn(function* scenario72() {
    yield* withFixture(
      Effect.fn(function* scenario73(fixture) {
        yield* run(fixture, 'action', [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action]);
        yield* run(fixture, scaffoldCommand.outboxMessage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
          '--topic',
          fixtureName.ordersCreated,
        ]);
        const manifestBefore = yield* readFixtureFile(fixture.root, inventoryManifestFile);
        const tsconfigBefore = yield* readFixtureFile(fixture.root, inventoryTsconfigFile);
        const args = [
          scaffoldFlag.vertical,
          inventorySlug,
          '--worker',
          'orders-created-projector',
          scaffoldFlag.producer,
          inventorySlug,
          '--topic',
          fixtureName.ordersCreated,
        ];
        yield* run(fixture, scaffoldCommand.outboxWorker, args);
        const worker = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/workers/orders-created-projector.worker.ts',
        );
        expect(worker.includes('// @ontos-outbox-worker-owner inventory.stock')).toBe(true);
        expect(worker.includes('// @ontos-outbox-worker-producer inventory.stock')).toBe(true);
        expect(worker.includes("from '@app/inventory-stock/outbox/orders-created'")).toBe(true);
        const registry = yield* readFixtureFile(fixture.root, 'verticals/inventory-stock/src/workers/index.ts');
        const hostLayer = yield* readFixtureFile(fixture.root, 'verticals/inventory-stock/src/worker-host/layer.ts');
        const hostMain = yield* readFixtureFile(fixture.root, 'verticals/inventory-stock/src/worker-host/main.ts');
        const hostScript = yield* readFixtureFile(fixture.root, 'verticals/inventory-stock/scripts/outbox-worker.ts');
        expect(registry.includes(workerRegistryEntry)).toBe(true);
        expect(hostLayer.includes('OutboxWorkerInfrastructureLive')).toBe(true);
        expect(hostMain.includes('startInventoryStockOutboxWorker();')).toBe(true);
        expect(hostScript.includes('startOutboxWorkerProcess({')).toBe(true);
        const registration = yield* readFixtureFile(fixture.root, inventoryRegistrationFile);
        expect(registration.includes('createOrderAction,')).toBe(true);
        expect(registration.includes(workerRegistryEntry)).toBe(true);
        expect(yield* readFixtureFile(fixture.root, inventoryManifestFile)).toBe(manifestBefore);
        expect(yield* readFixtureFile(fixture.root, inventoryTsconfigFile)).toBe(tsconfigBefore);
        const ownerPackage = yield* decodeFixturePackage(yield* readFixtureFile(fixture.root, inventoryPackageFile));
        expect(ownerPackage.dependencies['@app/core-runtime']).toBe(workspaceVersion);
        expect(ownerPackage.dependencies[inventoryPackageName]).toBe(undefined);
        expect(ownerPackage.exports['./outbox/orders-created']).toBe(generatedOutboxContractPath);
        for (const script of ['dev:worker', 'worker:start']) {
          expect(ownerPackage.scripts[script]).toBe(workerStartScript);
        }
        yield* assertScaffoldRefused(fixture, scaffoldCommand.outboxWorker, args, /refusing to overwrite/u);
        yield* run(fixture, 'action', [scaffoldFlag.vertical, inventorySlug, '--action', 'request-rebuild']);
        const registrationAfterAction = yield* readFixtureFile(fixture.root, inventoryRegistrationFile);
        expect(registrationAfterAction.includes('requestRebuildAction,')).toBe(true);
        expect(registrationAfterAction.includes(workerRegistryEntry)).toBe(true);
        yield* write(
          fixture.root,
          inventoryTsconfigFile,
          JSON.stringify({ references: [{ path: '../inventory-stock' }] }),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.outboxWorker,
          [
            scaffoldFlag.vertical,
            inventorySlug,
            '--worker',
            'orders-created-audit',
            scaffoldFlag.producer,
            inventorySlug,
            '--topic',
            fixtureName.ordersCreated,
          ],
          /circular self project reference/u,
        );
      }),
    );
  }),
);

it.live(
  'refuses unpublished or malformed Outbox contracts without partial consumer writes',
  Effect.fn(function* scenario74() {
    yield* withFixture(
      Effect.fn(function* scenario75(fixture) {
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.outboxWorker,
          [
            scaffoldFlag.vertical,
            'billing',
            '--worker',
            fixtureName.ordersLogger,
            scaffoldFlag.producer,
            inventorySlug,
            '--topic',
            'orders.missing',
          ],
          /published producer Outbox contract is missing/u,
        );

        yield* run(fixture, 'action', [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action]);
        yield* run(fixture, scaffoldCommand.outboxMessage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
          '--topic',
          fixtureName.ordersCreated,
        ]);
        const contractPath = path.join(fixture.root, inventoryOutboxContractFile);
        const validContract = yield* Effect.promise(() => readFile(contractPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(
            contractPath,
            validContract.replace('// @ontos-outbox-producer inventory.stock', '// @ontos-outbox-producer billing'),
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.outboxWorker,
          [
            scaffoldFlag.vertical,
            'billing',
            '--worker',
            fixtureName.ordersLogger,
            scaffoldFlag.producer,
            inventorySlug,
            '--topic',
            fixtureName.ordersCreated,
          ],
          /owner\/topic\/schema mismatch/u,
        );
      }),
    );
  }),
);

it.live(
  'generates fail-closed global and owner-local Policies with narrow exports',
  Effect.fn(function* scenario76() {
    yield* withFixture(
      Effect.fn(function* scenario77(fixture) {
        yield* run(fixture, 'policy', ['--scope', 'global', '--policy', fixtureName.policy]);
        yield* run(fixture, 'policy', ['--scope', 'global', '--policy', 'account-open']);
        yield* run(fixture, 'policy', [
          '--scope',
          'microvertical',
          '--policy',
          'stock-available',
          scaffoldFlag.vertical,
          inventorySlug,
        ]);

        expect(yield* readFixtureFile(fixture.root, 'packages/core-runtime/src/policies/tenant-active.policy.ts'))
          .toBe(`import { Effect } from 'effect';
import { defineGlobalPolicy, denyPolicy } from '../actions/policy.ts';

export const tenantActivePolicy = defineGlobalPolicy<unknown>({
  evaluate: () => Effect.fail(denyPolicy('policy_not_implemented', 'The Tenant Active Policy is not implemented')),
  policyKey: 'global.tenant-active.v1',
});
`);
        expect(yield* readFixtureFile(fixture.root, 'verticals/inventory-stock/src/policies/stock-available.policy.ts'))
          .toBe(`import { Effect } from 'effect';
import { defineMicroverticalPolicy, denyPolicy } from '@app/core-runtime';

export const stockAvailablePolicy = defineMicroverticalPolicy<unknown, 'inventory.stock'>({
  evaluate: () => Effect.fail(denyPolicy('policy_not_implemented', 'The Stock Available Policy is not implemented')),
  owningModuleKey: 'inventory.stock',
  policyKey: 'inventory.stock.stock-available.v1',
});
`);
        const coreIndex = yield* readFixtureFile(fixture.root, coreRuntimeIndexFile);
        expect(coreIndex).toBe(`export const existingCoreSurface = true;

// <generated-core-action-exports>
// </generated-core-action-exports>

// <generated-global-policy-exports>
export { accountOpenPolicy } from './policies/account-open.policy.ts';
export { tenantActivePolicy } from './policies/tenant-active.policy.ts';
// </generated-global-policy-exports>
`);
        expect(coreIndex).not.toMatch(/stockAvailablePolicy/u);
        expect(
          (yield* decodeFixturePackage(yield* readFixtureFile(fixture.root, inventoryPackageFile))).dependencies[
            '@app/core-runtime'
          ],
        ).toBe(workspaceVersion);
        yield* assertScaffoldRefused(
          fixture,
          'policy',
          ['--scope', 'global', '--policy', fixtureName.policy],
          /refusing to overwrite/u,
        );

        yield* run(fixture, 'policy', ['--scope', 'global', '--policy', 'foo-1-bar']);
        yield* assertScaffoldRefused(
          fixture,
          'policy',
          ['--scope', 'global', '--policy', 'foo1-bar'],
          /Policy identifier foo1BarPolicy already exists/u,
        );
      }),
    );
  }),
);

it.live(
  'generates a title-only authenticated page at the default MicroVertical URL',
  Effect.fn(function* scenario78() {
    yield* withFixture(
      Effect.fn(function* scenario79(fixture) {
        const shellBefore = yield* readFixtureFile(fixture.root, shellSentinelFile);
        const englishLocalePath = path.join(fixture.root, inventoryEnglishLocaleFile);
        yield* Effect.promise(() =>
          writeFile(englishLocalePath, '{\r\n    "inventory": {"existing":"en-preserved"}\r\n}', 'utf-8'),
        );
        const refreshes: string[] = [];
        yield* run(
          fixture,
          scaffoldCommand.microverticalPage,
          [scaffoldFlag.vertical, inventorySlug, '--page', fixtureName.purchaseOrdersPage],
          (appId) => {
            refreshes.push(appId);
          },
        );
        expect(refreshes).toEqual([inventorySlug, shellAppId]);
        const page = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/routes/[lang]/inventory-stock/purchase-orders/page.tsx',
        );
        expect(page).toBe(`import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';

export const PurchaseOrdersPage = () => {
  const { t } = useModernI18n();
  const headingId = 'purchase-orders-heading';

  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby={headingId}
        className="inventory:mx-auto inventory:w-full inventory:max-w-5xl inventory:px-4 inventory:py-8 inventory:sm:px-8 inventory:lg:px-12"
      >
        <h1
          className="inventory:text-3xl inventory:font-bold inventory:text-(--color-page-fg) inventory:sm:text-4xl"
          id={headingId}
        >
          {t('inventory.pages.purchaseOrders.title')}
        </h1>
      </section>
    </>
  );
};

export default PurchaseOrdersPage;
`);
        const manifest = yield* readFixtureFile(fixture.root, inventoryManifestFile);
        const registration = yield* readFixtureFile(fixture.root, inventoryRegistrationFile);
        const federation = yield* readFixtureFile(fixture.root, inventoryFederationConfigFile);
        const federatedPage = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/federation/page-purchase-orders.tsx',
        );
        const shellClients = yield* readFixtureFile(fixture.root, shellVerticalClientsFile);
        expect(manifest).toMatch(/inventory\.stock\.navigation\.purchase-orders/u);
        expect(manifest).toMatch(/inventory\.stock\.page\.purchase-orders/u);
        expect(manifest).toMatch(/routePath: '\/inventory-stock\/purchase-orders'/u);
        expect(registration).toMatch(/page-purchase-orders/u);
        expect(federation).toMatch(/'\.\/PagePurchaseOrders': '\.\/src\/federation\/page-purchase-orders\.tsx'/u);
        expect(federatedPage).toMatch(/<FederatedI18nBoundary/u);
        expect(federatedPage).toMatch(/resources=\{inventoryStockI18nResources\}/u);
        expect(shellClients).toMatch(
          /appId: 'inventory-stock',\s*componentKey: 'inventory\.stock\.page-purchase-orders',\s*load: \(\) => import\('inventoryStock\/PagePurchaseOrders'\)/u,
        );
        expect(
          yield* readFixtureFile(
            fixture.root,
            'apps/shell-super-app/src/routes/[lang]/inventory-stock/purchase-orders/page.tsx',
          ),
        ).toBe(`export { default } from '../../modules/[moduleId]/page.tsx';
`);
        expect(
          yield* readFixtureFile(
            fixture.root,
            'apps/shell-super-app/src/routes/[lang]/inventory-stock/purchase-orders/page.data.ts',
          ),
        ).toMatch(/entrypointKey: 'inventory\.stock\.page\.purchase-orders'/u);
        expect(
          yield* readFixtureFile(
            fixture.root,
            'apps/shell-super-app/src/routes/[lang]/inventory-stock/purchase-orders/route.meta.ts',
          ),
        ).toMatch(/canonicalPath: '\/inventory-stock\/purchase-orders'/u);
        expect(
          yield* readFixtureFile(
            fixture.root,
            'verticals/inventory-stock/src/routes/[lang]/inventory-stock/purchase-orders/route.meta.ts',
          ),
        ).toBe(`import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/inventory-stock/purchase-orders',
  descriptionKey: 'inventory.pages.purchaseOrders.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'inventory.stock.page.purchase-orders',
    moduleKey: 'inventory.stock',
    role: 'page',
  }),
  id: 'inventory-stock-purchase-orders',
  indexable: false,
  localisedPaths: {
    cs: '/inventory-stock/purchase-orders',
    en: '/inventory-stock/purchase-orders',
  },
  mfBoundaryId: 'verticalInventoryStock',
  moduleId: 'inventory.stock',
  namespace: 'inventory',
  ownerAppId: 'inventory-stock',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'inventory.pages.purchaseOrders.title',
} as const;

export default routeMeta;
export { routeMeta };
`);
        const englishContent = yield* Effect.promise(() => readFile(englishLocalePath, 'utf-8'));
        const english = yield* decodeInventoryLocale(englishContent);
        const czech = yield* decodeInventoryLocale(
          yield* readFixtureFile(fixture.root, 'verticals/inventory-stock/locales/cs/inventory.json'),
        );
        expect(english.inventory.existing).toBe('en-preserved');
        expect(englishContent).toMatch(/"inventory": \{"existing":"en-preserved", "pages":/u);
        expect(englishContent).not.toMatch(/(?<!\r)\n/u);
        expect(englishContent.endsWith('\r\n')).toBe(false);
        expect(english.inventory.pages['purchaseOrders']).toEqual({
          description: pagePlaceholder,
          title: 'New Page',
        });
        expect(czech.inventory.pages['purchaseOrders']).toEqual({
          description: 'Tato stránka je připravena k implementaci.',
          title: 'Nová stránka',
        });
        expect(yield* readFixtureFile(fixture.root, shellSentinelFile)).toBe(shellBefore);
        expect(page).not.toMatch(/fetch\(|useState|useEffect|<style|\.css'|\.description|\.empty/u);
      }),
    );
  }),
);

it.live(
  'allows a two-letter MicroVertical slug in a derived default page URL',
  Effect.fn(function* scenario80() {
    yield* withFixture(
      Effect.fn(function* scenario81(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalPage, [scaffoldFlag.vertical, 'hr', '--page', 'people']);
        yield* Effect.promise(() => stat(path.join(fixture.root, 'verticals/hr/src/routes/[lang]/hr/people/page.tsx')));
        expect(yield* readFixtureFile(fixture.root, 'verticals/hr/vertical.manifest.ts')).toMatch(
          /routePath: '\/hr\/people'/u,
        );
      }),
    );
  }),
);

it.live(
  'renders a newly generated federated page with English and Czech owner resources',
  Effect.fn(function* scenario82() {
    yield* withFixture(
      Effect.fn(function* scenario83(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalPage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          'customers',
        ]);
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'node_modules', '@modern-js'), {
            recursive: true,
          }),
        );
        yield* Effect.all(
          ['react', 'react-dom'].map(
            Effect.fn(function* scenario84(packageName) {
              return yield* Effect.promise(() =>
                symlink(
                  path.join(appRoot, 'apps', shellAppId, 'node_modules', packageName),
                  path.join(fixture.root, 'node_modules', packageName),
                  'dir',
                ),
              );
            }),
          ),
          { concurrency: 'unbounded' },
        );
        yield* write(
          fixture.root,
          'node_modules/@modern-js/plugin-i18n/package.json',
          json({
            exports: { './runtime': './runtime.tsx' },
            name: '@modern-js/plugin-i18n',
            type: 'module',
          }),
        );
        yield* write(
          fixture.root,
          'node_modules/@modern-js/plugin-i18n/runtime.tsx',
          `import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

interface BoundaryValue {
  readonly defaultNamespace: string;
  readonly resources: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;
}

const BoundaryContext = createContext<BoundaryValue>({ defaultNamespace: '', resources: {} });

export const FederatedI18nBoundary = ({
  children,
  defaultNamespace,
  resources,
}: BoundaryValue & { readonly children: ReactNode }) => (
  <BoundaryContext.Provider value={{ defaultNamespace, resources }}>
    {children}
  </BoundaryContext.Provider>
);

export const useModernI18n = () => {
  const boundary = useContext(BoundaryContext);
  return {
    t: (key: string) =>
      boundary.resources[process.env['PAGE_LANGUAGE'] ?? 'en']?.[boundary.defaultNamespace]?.[key] ??
      key,
  };
};
`,
        );
        const runnerPath = path.join(fixture.root, 'render-generated-page.tsx');
        yield* Effect.promise(() =>
          writeFile(
            runnerPath,
            `import { renderToStaticMarkup } from 'react-dom/server';
import Page from './verticals/inventory-stock/src/federation/page-customers.tsx';

process.stdout.write(renderToStaticMarkup(<Page />));
`,
            'utf-8',
          ),
        );
        const bundlePath = path.join(fixture.root, 'render-generated-page.cjs');
        const bundle = spawnSync(
          esbuildPath,
          [runnerPath, '--bundle', '--format=cjs', '--jsx=automatic', '--platform=node', `--outfile=${bundlePath}`],
          { cwd: fixture.root, encoding: 'utf-8' },
        );
        expect(bundle.error).toBeUndefined();
        expect(bundle.status, bundle.stderr).toBe(0);
        const renderLanguage = (language: 'cs' | 'en') =>
          spawnSync(process.execPath, [bundlePath], {
            cwd: fixture.root,
            encoding: 'utf-8',
            env: { PAGE_LANGUAGE: language },
          });
        const english = renderLanguage('en');
        const czech = renderLanguage('cs');
        expect(english.status, english.stderr).toBe(0);
        expect(czech.status, czech.stderr).toBe(0);
        expect(english.stdout).toMatch(/>New Page<\/h1>/u);
        expect(czech.stdout).toMatch(/>Nová stránka<\/h1>/u);
      }),
    );
  }),
);

it.live(
  'adds further pages after generated owner files have been formatted',
  Effect.fn(function* scenario85() {
    yield* withFixture(
      Effect.fn(function* scenario86(fixture) {
        const formattedOwnerPaths = [
          inventoryManifestFile,
          inventoryRegistrationFile,
          shellVerticalClientsFile,
        ] as const;
        const formatOwners = Effect.fn(function* scenario87() {
          for (const relativePath of formattedOwnerPaths) {
            const filePath = path.join(fixture.root, relativePath);
            const formatted = spawnSync(oxfmtPath, [`--stdin-filepath=${relativePath}`], {
              cwd: appRoot,
              encoding: 'utf-8',
              input: yield* Effect.promise(() => readFile(filePath, 'utf-8')),
            });
            expect(formatted.status, formatted.stderr).toBe(0);
            yield* Effect.promise(() => writeFile(filePath, formatted.stdout, 'utf-8'));
          }
        });

        yield* run(fixture, scaffoldCommand.microverticalPage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          fixtureName.purchaseOrdersPage,
        ]);
        yield* formatOwners();

        yield* run(fixture, scaffoldCommand.microverticalPage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          'customers',
        ]);
        yield* formatOwners();

        yield* run(fixture, scaffoldCommand.microverticalPage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          'customer-notes',
        ]);

        const manifest = yield* readFixtureFile(fixture.root, inventoryManifestFile);
        const registration = yield* readFixtureFile(fixture.root, inventoryRegistrationFile);
        const shellClients = yield* readFixtureFile(fixture.root, shellVerticalClientsFile);
        yield* Effect.all(
          ['customer-notes', 'customers', fixtureName.purchaseOrdersPage].map(
            Effect.fn(function* scenario89(page) {
              expect(manifest).toMatch(new RegExp(`inventory\\.stock\\.page\\.${page}`, 'u'));
              expect(registration).toMatch(new RegExp(`'page-${page}'`, 'u'));
              expect(shellClients).toMatch(new RegExp(`inventory\\.stock\\.page-${page}`, 'u'));
              yield* Effect.promise(() =>
                stat(
                  path.join(
                    fixture.root,
                    `verticals/inventory-stock/src/routes/[lang]/inventory-stock/${page}/page.tsx`,
                  ),
                ),
              );
            }),
          ),
          { concurrency: 'unbounded' },
        );
      }),
    );
  }),
);

it.live(
  'supports an explicit nested page URL and rejects unsafe URL inputs atomically',
  Effect.fn(function* scenario90() {
    yield* withFixture(
      Effect.fn(function* scenario91(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalPage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          fixtureName.purchaseOrdersPage,
          '--url',
          purchasingOrdersUrl,
        ]);
        const page = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/routes/[lang]/purchasing/orders/page.tsx',
        );
        expect(page).toMatch(/from '\.\.\/\.\.\/\.\.\/ultramodern-route-head'/u);
        const manifest = yield* readFixtureFile(fixture.root, inventoryManifestFile);
        expect(manifest).toMatch(/routePath: '\/purchasing\/orders'/u);
        expect(
          yield* readFixtureFile(fixture.root, 'apps/shell-super-app/src/routes/[lang]/purchasing/orders/page.data.ts'),
        ).toMatch(/entrypointKey: 'inventory\.stock\.page\.purchase-orders'/u);
        const beforeRerun = yield* snapshotTree(fixture.root);
        yield* run(fixture, scaffoldCommand.microverticalPage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          fixtureName.purchaseOrdersPage,
          '--url',
          purchasingOrdersUrl,
        ]);
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeRerun);
        yield* expectFailure(
          run(fixture, scaffoldCommand.microverticalPage, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--page',
            fixtureName.purchaseOrdersPage,
            '--url',
            '/different/orders',
          ]),
          (error) => expect(String(error)).toMatch(/already exists at another URL/u),
        );
        yield* expectFailure(
          run(fixture, scaffoldCommand.microverticalPage, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--page',
            'different-page',
            '--url',
            purchasingOrdersUrl,
          ]),
          (error) => expect(String(error)).toMatch(/already exists|collides/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeRerun);
      }),
    );

    yield* withFixture(
      Effect.fn(function* scenario92(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalPage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          'orders',
          '--url',
          '/orders',
        ]);
        yield* Effect.promise(() => stat(path.join(fixture.root, inventoryOrdersRouteFile)));
        expect(yield* readFixtureFile(fixture.root, inventoryManifestFile)).toMatch(/routePath: '\/orders'/u);
      }),
    );

    yield* Effect.all(
      [
        '/cs/orders',
        '/de/orders',
        '/en-us/orders',
        '/orders/',
        '/Orders',
        '/orders?state=open',
        '/orders#open',
        '/%2e%2e/orders',
        'https://example.test/orders',
      ].map(
        Effect.fn(function* scenario93(url) {
          return yield* withFixture(
            Effect.fn(function* scenario94(fixture) {
              yield* assertScaffoldRefused(
                fixture,
                scaffoldCommand.microverticalPage,
                [scaffoldFlag.vertical, inventorySlug, '--page', 'orders', '--url', url],
                /--url/u,
              );
            }),
          );
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.live(
  'generates a non-navigational dynamic page with canonical parameters and router directories',
  Effect.fn(function* scenario95() {
    yield* withFixture(
      Effect.fn(function* scenario96(fixture) {
        yield* write(
          fixture.root,
          inventoryFederationConfigFile,
          `export default {
  exposes: {
    './PageInventoryStock': './src/federation-entry.tsx',
  },
  manifest: {
    additionalData: ({ stats }) => ({ exposes: stats.exposes }),
  },
};
`,
        );
        const generatorArguments = [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          fixtureName.customerEditPage,
          '--url',
          '/contacts/customers/:id/edit',
        ];
        yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);

        const ownerRoute = 'verticals/inventory-stock/src/routes/[lang]/contacts/customers/[id]/edit';
        const shellRoute = 'apps/shell-super-app/src/routes/[lang]/contacts/customers/[id]/edit';
        const page = yield* readFixtureFile(fixture.root, `${ownerRoute}/page.tsx`);
        const ownerMetadata = yield* readFixtureFile(fixture.root, `${ownerRoute}/route.meta.ts`);
        const shellLoader = yield* readFixtureFile(fixture.root, `${shellRoute}/page.data.ts`);
        const shellMetadata = yield* readFixtureFile(fixture.root, `${shellRoute}/route.meta.ts`);
        const manifest = yield* readFixtureFile(fixture.root, inventoryManifestFile);
        const registration = yield* readFixtureFile(fixture.root, inventoryRegistrationFile);
        const federation = yield* readFixtureFile(fixture.root, inventoryFederationConfigFile);
        const federatedPage = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/federation/page-customer-edit.tsx',
        );
        const shellClients = yield* readFixtureFile(fixture.root, shellVerticalClientsFile);

        expect(page).toMatch(/export const CustomerEditPageRouteParams = Schema\.Struct/u);
        expect(page).toMatch(/id: Schema\.String\.pipe\(Schema\.brand\('CustomerEditPageIdRouteParameter'\)\)/u);
        expect(page).toMatch(/export type CustomerEditPageRouteParams = typeof CustomerEditPageRouteParams\.Type/u);
        expect(page).toMatch(/Schema\.toStandardSchemaV1\(\s*CustomerEditPageRouteParams,?\s*\)/u);
        expect(page).toMatch(/CustomerEditPage = \(\{ routeParams \}/u);
        expect(page).toMatch(/void routeParams;/u);
        expect(ownerMetadata).toMatch(/canonicalPath: '\/contacts\/customers\/:id\/edit'/u);
        expect(ownerMetadata).toMatch(/en: '\/contacts\/customers\/:id\/edit'/u);
        expect(shellMetadata).toMatch(/canonicalPath: '\/contacts\/customers\/:id\/edit'/u);
        expect(manifest).toMatch(/routePath: '\/contacts\/customers\/:id\/edit'/u);
        expect(manifest).toMatch(/inventory\.stock\.page\.customer-edit/u);
        expect(manifest).not.toMatch(/inventory\.stock\.navigation\.customer-edit/u);
        expect(registration).toMatch(/'page-customer-edit'/u);
        expect(federation).toMatch(/'\.\/PageCustomerEdit'/u);
        expect(federatedPage).toMatch(/type CustomerEditPageRouteParams/u);
        expect(federatedPage).not.toMatch(/Schema\.Struct/u);
        expect(federatedPage).toMatch(/<CustomerEditPage routeParams=\{routeParams\} \/>/u);
        expect(shellClients).toMatch(/inventory\.stock\.page-customer-edit/u);
        expect(shellLoader).toMatch(/selectRouteParams/u);
        expect(shellLoader).toMatch(/const routeParameterNames = \['id'\] as const;/u);
        expect(shellLoader).toMatch(/routeParams: selectRouteParams\(params, routeParameterNames\)/u);
        expect(yield* readFixtureFile(fixture.root, inventoryEnglishLocaleFile)).toMatch(/"customerEdit"/u);
        expect(yield* readFixtureFile(fixture.root, 'verticals/inventory-stock/locales/cs/inventory.json')).toMatch(
          /"customerEdit"/u,
        );

        const afterFirstRun = yield* snapshotTree(fixture.root);
        yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
        expect(yield* snapshotTree(fixture.root)).toEqual(afterFirstRun);
      }),
    );
  }),
);

it.live(
  'generates the Contacts Contact-detail two-parameter page atomically and safely reruns it',
  Effect.fn(function* scenario97() {
    const generatorArguments = [
      scaffoldFlag.vertical,
      inventorySlug,
      '--page',
      'contact-detail',
      '--url',
      '/contacts/customers/:id/contacts/:contactId',
    ];

    yield* withFixture(
      Effect.fn(function* scenario98(fixture) {
        const ownerRoute = 'verticals/inventory-stock/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]';
        const shellRoute = 'apps/shell-super-app/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]';

        yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);

        const page = yield* readFixtureFile(fixture.root, `${ownerRoute}/page.tsx`);
        const ownerMetadata = yield* readFixtureFile(fixture.root, `${ownerRoute}/route.meta.ts`);
        const shellLoader = yield* readFixtureFile(fixture.root, `${shellRoute}/page.data.ts`);
        const shellMetadata = yield* readFixtureFile(fixture.root, `${shellRoute}/route.meta.ts`);
        const manifest = yield* readFixtureFile(fixture.root, inventoryManifestFile);

        expect(page).toMatch(/export const ContactDetailPageRouteParams = Schema\.Struct/u);
        expect(page).toMatch(/id: Schema\.String\.pipe\(Schema\.brand\('ContactDetailPageIdRouteParameter'\)\)/u);
        expect(page).toMatch(
          /contactId: Schema\.String\.pipe\(Schema\.brand\('ContactDetailPageContactIdRouteParameter'\)\)/u,
        );
        expect(page).toMatch(/export type ContactDetailPageRouteParams = typeof ContactDetailPageRouteParams\.Type/u);
        expect(page).toMatch(/Schema\.toStandardSchemaV1\(\s*ContactDetailPageRouteParams,?\s*\)/u);
        expect(ownerMetadata).toMatch(/canonicalPath: '\/contacts\/customers\/:id\/contacts\/:contactId'/u);
        expect(shellMetadata).toMatch(/canonicalPath: '\/contacts\/customers\/:id\/contacts\/:contactId'/u);
        expect(manifest).toMatch(/routePath: '\/contacts\/customers\/:id\/contacts\/:contactId'/u);
        expect(manifest).toMatch(/inventory\.stock\.page\.contact-detail/u);
        expect(manifest).not.toMatch(/inventory\.stock\.navigation\.contact-detail/u);
        expect(shellLoader).toMatch(/const routeParameterNames = \['id', 'contactId'\] as const;/u);
        expect(shellLoader).toMatch(/routeParams: selectRouteParams\(params, routeParameterNames\)/u);
        yield* Effect.promise(() => stat(path.join(fixture.root, ownerRoute)));
        yield* Effect.promise(() => stat(path.join(fixture.root, shellRoute)));

        const afterFirstRun = yield* snapshotTree(fixture.root);
        yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
        expect(yield* snapshotTree(fixture.root)).toEqual(afterFirstRun);
      }),
    );

    yield* withFixture(
      Effect.fn(function* scenario99(fixture) {
        yield* write(
          fixture.root,
          'apps/shell-super-app/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]/page.tsx',
          'export default function DeveloperOwnedPage() { return null; }\n',
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.microverticalPage,
          generatorArguments,
          /refusing to overwrite|already exists/u,
        );
      }),
    );
  }),
);

it.live(
  'rejects unsafe dynamic parameters and dynamic route collisions without writing',
  Effect.fn(function* scenario100() {
    yield* Effect.all(
      [
        '/inventory/customers/:1id/edit',
        '/inventory/customers/:customer-id/edit',
        '/inventory/customers/:id?/edit',
        '/inventory/customers/:id*/edit',
        '/inventory/customers/*id/edit',
        '/inventory/customers/[id]/edit',
        '/inventory/customers/:id/edit/:id',
        '/inventory/customers/%2e%2e/:id',
        '/cs/inventory/customers/:id',
      ].map(
        Effect.fn(function* scenario101(url) {
          return yield* withFixture(
            Effect.fn(function* scenario102(fixture) {
              yield* assertScaffoldRefused(
                fixture,
                scaffoldCommand.microverticalPage,
                [scaffoldFlag.vertical, inventorySlug, '--page', fixtureName.customerEditPage, '--url', url],
                /--url/u,
              );
            }),
          );
        }),
      ),
      { concurrency: 'unbounded' },
    );

    yield* Effect.all(
      [
        withFixture(
          Effect.fn(function* scenario103(fixture) {
            yield* run(fixture, scaffoldCommand.microverticalPage, [
              scaffoldFlag.vertical,
              inventorySlug,
              '--page',
              'customer-detail',
              '--url',
              customerDetailUrl,
            ]);
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.microverticalPage,
              [
                scaffoldFlag.vertical,
                inventorySlug,
                '--page',
                fixtureName.customerEditPage,
                '--url',
                '/inventory/customers/:customerId',
              ],
              /routing collision|already registered|collides/u,
            );
          }),
        ),
        withFixture(
          Effect.fn(function* scenario104(fixture) {
            const generatorArguments = [
              scaffoldFlag.vertical,
              inventorySlug,
              '--page',
              fixtureName.customerEditPage,
              '--url',
              customerEditUrl,
            ];
            yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
            const pagePath = path.join(
              fixture.root,
              'verticals/inventory-stock/src/routes/[lang]/inventory/customers/[id]/edit/page.tsx',
            );
            const pageSource = yield* Effect.promise(() => readFile(pagePath, 'utf-8'));
            yield* Effect.promise(() => writeFile(pagePath, `${pageSource}\n// developer edit\n`, 'utf-8'));
            yield* assertScaffoldRefused(fixture, scaffoldCommand.microverticalPage, generatorArguments, /collides/u);
          }),
        ),
        withFixture(
          Effect.fn(function* scenario105(fixture) {
            yield* write(
              fixture.root,
              'verticals/inventory-stock/src/routes/[lang]/inventory/customers/[id]/edit/page.tsx',
              'export default function PartialPage() { return null; }\n',
            );
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.microverticalPage,
              [scaffoldFlag.vertical, inventorySlug, '--page', fixtureName.customerEditPage, '--url', customerEditUrl],
              /collides with nested content/u,
            );
          }),
        ),
        withFixture(
          Effect.fn(function* scenario106(fixture) {
            yield* run(fixture, scaffoldCommand.microverticalPage, [
              scaffoldFlag.vertical,
              inventorySlug,
              '--page',
              'customer-new',
              '--url',
              '/inventory/customers/new',
            ]);
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.microverticalPage,
              [
                scaffoldFlag.vertical,
                inventorySlug,
                '--page',
                fixtureName.customerEditPage,
                '--url',
                customerDetailUrl,
              ],
              /static route segment|collides/u,
            );
          }),
        ),
        withFixture(
          Effect.fn(function* scenario107(fixture) {
            yield* run(fixture, scaffoldCommand.microverticalPage, [
              scaffoldFlag.vertical,
              'billing',
              '--page',
              fixtureName.customerEditPage,
              '--url',
              '/shared/customers/:id/edit',
            ]);
            yield* Effect.promise(() =>
              rm(path.join(fixture.root, 'apps/shell-super-app/src/routes/[lang]/shared/customers/[id]/edit'), {
                recursive: true,
              }),
            );
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.microverticalPage,
              [
                scaffoldFlag.vertical,
                inventorySlug,
                '--page',
                fixtureName.customerEditPage,
                '--url',
                '/shared/customers/:id/edit',
              ],
              /already registered by billing/u,
            );
          }),
        ),
      ],
      { concurrency: 'unbounded' },
    );
  }),
);

it.live(
  'extends an existing dynamic route branch without reclassifying an existing static sibling',
  Effect.fn(function* scenario108() {
    yield* withFixture(
      Effect.fn(function* scenario109(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalPage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          'customer-detail',
          '--url',
          customerDetailUrl,
        ]);
        yield* write(
          fixture.root,
          'apps/shell-super-app/src/routes/[lang]/inventory/customers/new/page.tsx',
          'export default function ExistingStaticSibling() { return null; }\n',
        );

        yield* run(fixture, scaffoldCommand.microverticalPage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          fixtureName.customerEditPage,
          '--url',
          customerEditUrl,
        ]);

        yield* Effect.promise(() =>
          stat(
            path.join(fixture.root, 'apps/shell-super-app/src/routes/[lang]/inventory/customers/[id]/edit/page.tsx'),
          ),
        );
      }),
    );
  }),
);

it.live(
  'rejects reserved, dynamic, and cross-owner page URLs before writing',
  Effect.fn(function* scenario110() {
    yield* Effect.all(
      [
        withFixture(
          Effect.fn(function* scenario111(fixture) {
            yield* write(
              fixture.root,
              'apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx',
              'export default function ModulePage() { return null; }\n',
            );
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.microverticalPage,
              [scaffoldFlag.vertical, inventorySlug, '--page', 'customers', '--url', '/modules/customers'],
              /collides with dynamic route segment \[moduleId\]/u,
            );
          }),
        ),
        withFixture(
          Effect.fn(function* scenario112(fixture) {
            yield* write(
              fixture.root,
              'apps/shell-super-app/src/routes/[lang]/login/page.tsx',
              'export default function LoginPage() { return null; }\n',
            );
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.microverticalPage,
              [scaffoldFlag.vertical, inventorySlug, '--page', 'customers', '--url', '/login/customers'],
              /reserved route prefix \/login/u,
            );
          }),
        ),
        withFixture(
          Effect.fn(function* scenario113(fixture) {
            yield* run(fixture, scaffoldCommand.microverticalPage, [
              scaffoldFlag.vertical,
              'billing',
              '--page',
              'customers',
              '--url',
              '/shared/customers',
            ]);
            yield* Effect.promise(() =>
              rm(path.join(fixture.root, 'apps/shell-super-app/src/routes/[lang]/shared/customers'), {
                recursive: true,
              }),
            );
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.microverticalPage,
              [scaffoldFlag.vertical, inventorySlug, '--page', 'customer-list', '--url', '/shared/customers'],
              /already registered by billing/u,
            );
          }),
        ),
      ],
      { concurrency: 'unbounded' },
    );
  }),
);

it.live(
  'uses exact page identities and rejects edited generated wiring',
  Effect.fn(function* scenario114() {
    yield* withFixture(
      Effect.fn(function* scenario115(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalPage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          'order-lines',
        ]);
        yield* run(fixture, scaffoldCommand.microverticalPage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          'order',
        ]);
        yield* Effect.promise(() =>
          stat(path.join(fixture.root, 'verticals/inventory-stock/src/routes/[lang]/inventory-stock/order/page.tsx')),
        );
      }),
    );

    yield* Effect.all(
      [
        withFixture(
          Effect.fn(function* scenario116(fixture) {
            yield* run(fixture, scaffoldCommand.microverticalPage, [
              scaffoldFlag.vertical,
              inventorySlug,
              '--page',
              'orders',
              '--url',
              '/first/orders',
            ]);
            const manifestPath = path.join(fixture.root, inventoryManifestFile);
            const manifest = yield* Effect.promise(() => readFile(manifestPath, 'utf-8'));
            yield* Effect.promise(() =>
              writeFile(
                manifestPath,
                manifest
                  .replaceAll("'page-orders'", '"page-orders"')
                  .replaceAll("'inventory.stock.page.orders'", '"inventory.stock.page.orders"'),
                'utf-8',
              ),
            );
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.microverticalPage,
              [scaffoldFlag.vertical, inventorySlug, '--page', 'orders', '--url', '/second/orders'],
              /page identity inventory\.stock\.page\.orders already exists/u,
            );
          }),
        ),
        withFixture(
          Effect.fn(function* scenario117(fixture) {
            const generatorArguments = [scaffoldFlag.vertical, inventorySlug, '--page', 'orders'];
            yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
            const manifestPath = path.join(fixture.root, inventoryManifestFile);
            const manifest = yield* Effect.promise(() => readFile(manifestPath, 'utf-8'));
            yield* Effect.promise(() => writeFile(manifestPath, manifest.replace('order: 100', 'order: 101'), 'utf-8'));
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.microverticalPage,
              generatorArguments,
              /already exists|collides/u,
            );
          }),
        ),
        withFixture(
          Effect.fn(function* scenario118(fixture) {
            const generatorArguments = [scaffoldFlag.vertical, inventorySlug, '--page', 'orders'];
            yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
            const manifestPath = path.join(fixture.root, inventoryManifestFile);
            const manifest = yield* Effect.promise(() => readFile(manifestPath, 'utf-8'));
            yield* Effect.promise(() =>
              writeFile(
                manifestPath,
                manifest.replace(
                  '// </generated-module-shell-navigation>',
                  `{ contributionKey : "inventory.stock.navigation.orders", entrypoint: { access: 'read', entrypointKey: 'inventory.stock.page.orders', moduleKey: 'inventory.stock', role: 'page', scope: 'tenant' }, groupKey: 'shell.navigation.modules', order: 101, pageKey: 'inventory.stock.page.orders' },
        // </generated-module-shell-navigation>`,
                ),
                'utf-8',
              ),
            );
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.microverticalPage,
              generatorArguments,
              /already exists|collides/u,
            );
          }),
        ),
        withFixture(
          Effect.fn(function* scenario119(fixture) {
            const generatorArguments = [scaffoldFlag.vertical, inventorySlug, '--page', 'orders'];
            yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
            const federationPath = path.join(fixture.root, inventoryFederationConfigFile);
            const federation = yield* Effect.promise(() => readFile(federationPath, 'utf-8'));
            yield* Effect.promise(() =>
              writeFile(
                federationPath,
                federation.replace("'./src/federation/page-orders.tsx'", "'./src/federation/page-other.tsx'"),
                'utf-8',
              ),
            );
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.microverticalPage,
              generatorArguments,
              /already exists|collides/u,
            );
          }),
        ),
        withFixture(
          Effect.fn(function* scenario120(fixture) {
            const generatorArguments = [scaffoldFlag.vertical, inventorySlug, '--page', 'orders'];
            yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
            yield* write(
              fixture.root,
              'apps/shell-super-app/src/routes/[lang]/inventory-stock/orders/developer-note.ts',
              'export const developerNote = true;\n',
            );
            yield* assertScaffoldRefused(
              fixture,
              scaffoldCommand.microverticalPage,
              generatorArguments,
              /already exists|collides/u,
            );
          }),
        ),
      ],
      { concurrency: 'unbounded' },
    );
  }),
);

it.live(
  'rejects obsolete generated page output without changing files',
  Effect.fn(function* mergedScenario78() {
    yield* withFixture(
      Effect.fn(function* mergedScenario77(fixture) {
        const generatorArguments = [scaffoldFlag.vertical, inventorySlug, '--page', 'orders', '--url', '/orders'];
        yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
        yield* write(
          fixture.root,
          inventoryOrdersRouteFile,
          `import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

export const OrdersPage = () => {
  const { t } = useModernI18n();
  const headingId = 'orders-heading';

  return (
    <>
      <UltramodernRouteHead />
      <main className="inventory:min-h-screen inventory:bg-(--color-page-bg) inventory:px-4 inventory:py-8 inventory:text-(--color-page-fg) inventory:sm:px-8 inventory:lg:px-12">
        <div className="inventory:mx-auto inventory:flex inventory:max-w-5xl inventory:flex-col inventory:gap-8">
          <header className="inventory:space-y-3">
            <h1
              className="inventory:text-3xl inventory:font-bold inventory:sm:text-4xl"
              id={headingId}
            >
              {t('inventory.pages.orders.title')}
            </h1>
            <p className="inventory:max-w-2xl inventory:text-base inventory:sm:text-lg">
              {t('inventory.pages.orders.description')}
            </p>
          </header>
          <section
            aria-labelledby={headingId}
            className="inventory:bg-(--color-surface) inventory:p-6 inventory:sm:p-8"
          >
            <p>{t('inventory.pages.orders.empty')}</p>
          </section>
        </div>
      </main>
    </>
  );
};

export default OrdersPage;
`,
        );
        yield* write(
          fixture.root,
          'apps/shell-super-app/src/routes/[lang]/orders/page.data.ts',
          `import { loader as loadModuleTarget } from '../modules/[moduleId]/page.data.ts';

interface ShellPageLoaderArguments {
  readonly request: Request;
}

export const loader = ({ request }: ShellPageLoaderArguments) =>
  loadModuleTarget({ params: { moduleId: 'inventory.stock' }, request });
`,
        );
        yield* Effect.all(
          ['cs', 'en'].map(
            Effect.fn(function* mergedScenario76(locale) {
              const localePath = path.join(fixture.root, `verticals/inventory-stock/locales/${locale}/inventory.json`);
              const catalog = yield* decodeInventoryLocale(yield* Effect.promise(() => readFile(localePath, 'utf-8')));
              const ordersPage =
                locale === 'cs'
                  ? {
                      description: 'Tato stránka je připravena k implementaci.',
                      empty: 'Zatím zde není žádný obsah.',
                      title: 'Nová stránka',
                    }
                  : {
                      description: pagePlaceholder,
                      empty: 'No content has been added yet.',
                      title: 'New Page',
                    };
              const nextCatalog = yield* Schema.decodeUnknownEffect(Schema.Json)({
                ...catalog,
                inventory: {
                  ...catalog.inventory,
                  pages: { ...catalog.inventory.pages, orders: ordersPage },
                },
              });
              yield* Effect.promise(() => writeFile(localePath, json(nextCatalog), 'utf-8'));
            }),
          ),
          { concurrency: 'unbounded' },
        );

        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.microverticalPage,
          generatorArguments,
          /page route already exists or collides/u,
        );
      }),
    );
  }),
);

it.live(
  'rejects page generation when an owning locale has no truthful starter translation',
  Effect.fn(function* scenario124() {
    yield* withFixture(
      Effect.fn(function* scenario125(fixture) {
        const packagePath = path.join(fixture.root, inventoryPackageFile);
        const packageJson = yield* decodeFixturePackage(yield* Effect.promise(() => readFile(packagePath, 'utf-8')));
        yield* Effect.promise(() =>
          writeFile(
            packagePath,
            json({
              ...packageJson,
              exports: {
                ...packageJson.exports,
                './locales/de': './locales/de/inventory.json',
              },
            }),
            'utf-8',
          ),
        );
        yield* write(
          fixture.root,
          'verticals/inventory-stock/locales/de/inventory.json',
          json({ inventory: { existing: 'de-preserved' } }),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.microverticalPage,
          [scaffoldFlag.vertical, inventorySlug, '--page', fixtureName.purchaseOrdersPage],
          /no starter translation for locale de/u,
        );
      }),
    );
  }),
);

it.live(
  'page prerequisite and nested-route failures are preflighted, while refresh failure is safely rerunnable',
  Effect.fn(function* scenario126() {
    yield* withFixture(
      Effect.fn(function* scenario127(fixture) {
        yield* Effect.promise(() =>
          rm(path.join(fixture.root, 'verticals/inventory-stock/src/routes/ultramodern-route-head.tsx')),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.microverticalPage,
          [scaffoldFlag.vertical, inventorySlug, '--page', 'orders'],
          /UltramodernRouteHead is missing/u,
        );
      }),
    );

    yield* withFixture(
      Effect.fn(function* scenario128(fixture) {
        yield* write(
          fixture.root,
          'verticals/inventory-stock/src/routes/[lang]/inventory-stock/orders/nested.ts',
          'export {};\n',
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.microverticalPage,
          [scaffoldFlag.vertical, inventorySlug, '--page', 'orders'],
          /collides with nested content/u,
        );
      }),
    );

    yield* withFixture(
      Effect.fn(function* scenario129(fixture) {
        yield* expectFailure(
          runScaffoldEffect(
            scaffoldCommand.microverticalPage,
            [
              scaffoldFlag.vertical,
              inventorySlug,
              '--page',
              'orders',
              scaffoldFlag.authorization,
              'context_permission',
              '--permission',
              'module.access',
            ],
            {
              routeRefresh: () =>
                Effect.fail(
                  new ScaffoldingError({
                    message: 'route refresh fixture failure',
                  }),
                ),
              workspaceRoot: fixture.root,
            },
          ).pipe(Effect.provide(NodeServices.layer)),
          (error) => expect(String(error)).toMatch(/route refresh fixture failure/u),
        );
        yield* Effect.promise(() =>
          stat(path.join(fixture.root, 'verticals/inventory-stock/src/routes/[lang]/inventory-stock/orders/page.tsx')),
        );
        const afterRefreshFailure = yield* snapshotTree(fixture.root);
        const refreshes: string[] = [];
        yield* run(
          fixture,
          scaffoldCommand.microverticalPage,
          [scaffoldFlag.vertical, inventorySlug, '--page', 'orders'],
          (appId) => {
            refreshes.push(appId);
          },
        );
        expect(refreshes).toEqual([inventorySlug, shellAppId]);
        expect(yield* snapshotTree(fixture.root)).toEqual(afterRefreshFailure);
      }),
    );
  }),
);

const runCombinedScenario = (fixture: Fixture): Effect.Effect<Readonly<Record<string, string>>, unknown> =>
  Effect.gen(function* scenario130() {
    yield* addInventoryItemResourceType(fixture);
    yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [scaffoldFlag.vertical, inventorySlug]);
    yield* run(fixture, scaffoldCommand.externalHttpAdapter, [
      scaffoldFlag.vertical,
      inventorySlug,
      scaffoldFlag.provider,
      'warehouse-api',
      scaffoldFlag.operation,
      'stock-level',
    ]);
    yield* run(fixture, 'action', [
      '--scope',
      'core',
      '--module',
      fixtureName.actionModule,
      '--action',
      'change-tenant-state',
    ]);
    yield* run(fixture, 'action', [scaffoldFlag.vertical, inventorySlug, '--action', fixtureName.action]);
    yield* run(fixture, scaffoldCommand.outboxMessage, [
      scaffoldFlag.vertical,
      inventorySlug,
      '--action',
      fixtureName.action,
      '--topic',
      fixtureName.ordersCreated,
    ]);
    yield* run(fixture, 'policy', ['--scope', 'global', '--policy', fixtureName.policy]);
    yield* run(fixture, 'policy', [
      '--scope',
      'microvertical',
      '--policy',
      'stock-available',
      scaffoldFlag.vertical,
      inventorySlug,
    ]);
    yield* run(fixture, scaffoldCommand.moduleApi, [
      scaffoldFlag.vertical,
      inventorySlug,
      '--name',
      fixtureName.resourceDetail,
    ]);
    yield* run(fixture, scaffoldCommand.searchProvider, [
      scaffoldFlag.vertical,
      inventorySlug,
      '--name',
      fixtureName.inventoryItems,
      scaffoldFlag.resource,
      'item',
    ]);
    yield* run(fixture, 'report', [
      scaffoldFlag.vertical,
      inventorySlug,
      '--name',
      fixtureName.stockLevels,
      scaffoldFlag.resource,
      'item',
    ]);
    yield* run(
      fixture,
      scaffoldCommand.microverticalPage,
      [scaffoldFlag.vertical, inventorySlug, '--page', 'orders'],
      (appId) => expect([inventorySlug, shellAppId].includes(appId)).toBe(true),
    );
    yield* run(fixture, scaffoldCommand.microverticalPage, [
      scaffoldFlag.vertical,
      inventorySlug,
      '--page',
      fixtureName.customerEditPage,
      '--url',
      '/contacts/customers/:id/edit',
    ]);
    return yield* snapshotTree(fixture.root);
  });

it.live(
  'all generators compose deterministically without crossing owner boundaries',
  Effect.fn(function* scenario131() {
    const first = yield* createFixture();
    const second = yield* createFixture();
    yield* Effect.gen(function* useResource3() {
      const billingBefore = Object.fromEntries(
        Object.entries(yield* snapshotTree(first.root)).filter(([file]) => file.startsWith('verticals/billing/')),
      );
      const shellBefore = yield* readFixtureFile(first.root, shellSentinelFile);
      const topologyBefore = yield* readFixtureFile(first.root, topologyFile);
      const firstTree = yield* runCombinedScenario(first);
      const secondTree = yield* runCombinedScenario(second);
      expect(firstTree).toEqual(secondTree);
      const billingAfter = Object.fromEntries(
        Object.entries(firstTree).filter(([file]) => file.startsWith('verticals/billing/')),
      );
      expect(billingAfter).toEqual(billingBefore);
      expect(yield* readFixtureFile(first.root, shellSentinelFile)).toBe(shellBefore);
      expect(yield* readFixtureFile(first.root, topologyFile)).toBe(topologyBefore);
      const combinedSource = Object.values(firstTree).join('\n');
      expect(combinedSource).not.toMatch(/from ['"]\.\.\/\.\.\/billing|fetch\(/u);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* releaseResources3() {
          yield* Effect.promise(() => rm(first.root, { force: true, recursive: true }));
          yield* Effect.promise(() => rm(second.root, { force: true, recursive: true }));
        }),
      ),
    );
  }),
);

it.live(
  'every generated TypeScript file is already formatter-stable',
  Effect.fn(function* mergedScenario85() {
    yield* withFixture(
      Effect.fn(function* mergedScenario84(fixture) {
        yield* runCombinedScenario(fixture);
        yield* run(fixture, scaffoldCommand.outboxWorker, [
          scaffoldFlag.vertical,
          'billing',
          '--worker',
          fixtureName.ordersCreatedLogger,
          scaffoldFlag.producer,
          inventorySlug,
          '--topic',
          fixtureName.ordersCreated,
        ]);
        const generatedFiles = [
          'packages/core-runtime/src/modules/actions/change-tenant-state.action.ts',
          'packages/core-runtime/src/policies/tenant-active.policy.ts',
          inventoryActionFile,
          'verticals/inventory-stock/src/integrations/warehouse-api/warehouse-api-stock-level.service.ts',
          'verticals/inventory-stock/src/actions/create-order.orders-created.outbox-message.ts',
          inventoryOutboxContractFile,
          billingWorkersIndexFile,
          billingApiIndexFile,
          'verticals/billing/src/workers/orders-created-logger.worker.ts',
          'verticals/billing/src/worker-host/layer.ts',
          'verticals/billing/src/worker-host/main.ts',
          'verticals/billing/scripts/outbox-worker.ts',
          'verticals/inventory-stock/src/policies/stock-available.policy.ts',
          'verticals/inventory-stock/src/routes/[lang]/inventory-stock/orders/page.tsx',
          'verticals/inventory-stock/src/routes/[lang]/inventory-stock/orders/route.meta.ts',
          'verticals/inventory-stock/src/federation/page-orders.tsx',
          inventoryActionPrincipalFile,
          inventoryActionHttpRunnerFile,
          inventoryActionGatewayFile,
          inventoryModuleApiContractFile,
          inventoryModuleApiReadFile,
          inventoryModuleApiClientFile,
          inventoryModuleApiServerFile,
          inventorySearchContractFile,
          inventorySearchProviderFile,
          inventorySearchClientFile,
          inventorySearchServerFile,
          inventoryReportContractFile,
          inventoryReportProviderFile,
          inventoryReportClientFile,
          inventoryReportServerFile,
        ];

        yield* Effect.all(
          generatedFiles.map(
            Effect.fn(function* mergedScenario83(relativePath) {
              const source = yield* readFixtureFile(fixture.root, relativePath);
              const formatted = spawnSync(oxfmtPath, [`--stdin-filepath=${relativePath}`], {
                cwd: appRoot,
                encoding: 'utf-8',
                input: source,
              });
              expect(formatted.status, formatted.stderr).toBe(0);
              expect(formatted.stdout, `${relativePath} must be formatter-stable`).toBe(source);
            }),
          ),
          { concurrency: 'unbounded' },
        );
      }),
    );
  }),
);

it.live(
  'all generated files typecheck against the real workspace contracts',
  Effect.fn(function* mergedScenario92() {
    yield* withFixture(
      Effect.fn(function* mergedScenario91(fixture) {
        yield* runCombinedScenario(fixture);
        yield* run(fixture, scaffoldCommand.outboxWorker, [
          scaffoldFlag.vertical,
          'billing',
          '--worker',
          fixtureName.ordersCreatedLogger,
          scaffoldFlag.producer,
          inventorySlug,
          '--topic',
          fixtureName.ordersCreated,
        ]);
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'node_modules', '@authzed'), {
            recursive: true,
          }),
        );
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'node_modules', '@effect'), {
            recursive: true,
          }),
        );
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'node_modules', '@modern-js'), {
            recursive: true,
          }),
        );
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'node_modules', '@types'), {
            recursive: true,
          }),
        );
        // Every generated-runtime dependency is linked from the real workspace so the fixture
        // typechecks and runs against the same modules the shipped verticals resolve.
        yield* Effect.all(
          (
            [
              ['packages/core-runtime/node_modules/effect', effectNodeModulePath, 'dir'],
              ['packages/core-runtime/node_modules/@effect/sql-pg', 'node_modules/@effect/sql-pg', 'dir'],
              ['packages/core-runtime/node_modules/@effect/platform-node', 'node_modules/@effect/platform-node', 'dir'],
              ['apps/shell-super-app/node_modules/jose', 'node_modules/jose', 'dir'],
              ['packages/core-runtime/node_modules/drizzle-orm', 'node_modules/drizzle-orm', 'dir'],
              ['packages/core-runtime/node_modules/dotenv', 'node_modules/dotenv', 'dir'],
              ['packages/core-runtime/node_modules/pg', 'node_modules/pg', 'dir'],
              ['packages/core-runtime/node_modules/@authzed/authzed-node', 'node_modules/@authzed/authzed-node', 'dir'],
              [
                'apps/shell-super-app/node_modules/@modern-js/plugin-i18n',
                'node_modules/@modern-js/plugin-i18n',
                'dir',
              ],
              ['apps/shell-super-app/node_modules/@modern-js/plugin-bff', pluginBffNodeModulePath, 'dir'],
              ['apps/shell-super-app/node_modules/@types/react', 'node_modules/@types/react', 'dir'],
              ['packages/core-runtime/node_modules/@types/pg', 'node_modules/@types/pg', 'dir'],
              ['node_modules/@types/node', 'node_modules/@types/node', 'dir'],
              ['packages/core-runtime/src/actions', 'packages/core-runtime/src/actions', 'dir'],
              ['packages/core-runtime/src/db', 'packages/core-runtime/src/db', 'dir'],
              ['packages/core-runtime/src/operations', 'packages/core-runtime/src/operations', 'dir'],
              ['packages/core-runtime/src/database', 'packages/core-runtime/src/database', 'dir'],
              ['packages/core-runtime/src/environment', 'packages/core-runtime/src/environment', 'dir'],
              ['packages/core-runtime/src/permissions', 'packages/core-runtime/src/permissions', 'dir'],
              ['packages/core-runtime/src/auth', 'packages/core-runtime/src/auth', 'dir'],
              ['packages/core-runtime/src/authorization', 'packages/core-runtime/src/authorization', 'dir'],
              [
                'packages/core-runtime/src/modules/module-entrypoint.ts',
                'packages/core-runtime/src/modules/module-entrypoint.ts',
                'file',
              ],
            ] as const
          ).map(([source, target, kind]) =>
            Effect.promise(() => symlink(path.join(appRoot, source), path.join(fixture.root, target), kind)),
          ),
          { concurrency: 'unbounded' },
        );
        yield* Effect.all(
          [
            'module-entrypoint-gateway.ts',
            'module-state-check-unavailable-error.ts',
            'module-state-denied-error.ts',
            'module-state-gate-errors.ts',
            'module-state-gate.ts',
            'tenant-module-state-errors.ts',
            'tenant-module-state-service.ts',
          ].map(
            Effect.fn(function* mergedScenario90(moduleFile) {
              return yield* Effect.promise(() =>
                symlink(
                  path.join(appRoot, 'packages/core-runtime/src/modules', moduleFile),
                  path.join(fixture.root, 'packages/core-runtime/src/modules', moduleFile),
                  'file',
                ),
              );
            }),
          ),
          { concurrency: 'unbounded' },
        );
        const fixtureTsconfig = path.join(fixture.root, 'tsconfig.generated.json');
        yield* Effect.promise(() =>
          writeFile(
            fixtureTsconfig,
            json({
              compilerOptions: {
                allowImportingTsExtensions: true,
                jsx: 'preserve',
                module: 'preserve',
                moduleResolution: 'Bundler',
                noEmit: true,
                paths: {
                  '@app/core-runtime': [path.join(appRoot, coreRuntimeIndexFile)],
                  '@app/core-runtime/actions/principal-context': [
                    path.join(appRoot, 'packages/core-runtime/src/actions/principal-context.ts'),
                  ],
                  '@app/core-runtime/actions/runtime-wiring': [
                    path.join(appRoot, 'packages/core-runtime/src/actions/runtime-wiring.ts'),
                  ],
                  '@app/core-runtime/auth/gateway-assertion-redemption': [
                    path.join(appRoot, 'packages/core-runtime/src/auth/gateway-assertion-redemption.ts'),
                  ],
                  '@app/core-runtime/http/action-runner': [
                    path.join(appRoot, 'packages/core-runtime/src/http/http-instrumentation-seam.ts'),
                  ],
                  '@app/core-runtime/http/governed-read': [
                    path.join(appRoot, 'packages/core-runtime/src/http/governed-read.ts'),
                  ],
                  '@app/core-runtime/http/principal-authentication': [
                    path.join(appRoot, 'packages/core-runtime/src/http/principal-authentication.ts'),
                  ],
                  '@app/core-runtime/outbox/worker': [
                    path.join(appRoot, 'packages/core-runtime/src/outbox/worker-entrypoint.ts'),
                  ],
                  '@app/gateway-principal-verifier/server': [
                    path.join(appRoot, 'packages/gateway-principal-verifier/src/server.ts'),
                  ],
                  '@app/inventory-stock/outbox/*': ['./verticals/inventory-stock/shared/outbox/*.ts'],
                  '@app/shared-contracts': [path.join(appRoot, 'packages/shared-contracts/src/index.ts')],
                  '@app/shared-contracts/client-runtime': [
                    path.join(appRoot, 'packages/shared-contracts/src/client-runtime.ts'),
                  ],
                  '@app/shared-contracts/problem-details': [
                    path.join(appRoot, 'packages/shared-contracts/src/problem-details.ts'),
                  ],
                  '@app/shared-contracts/server/effect-bff-runtime': [
                    path.join(appRoot, 'packages/shared-contracts/src/effect-bff-runtime.ts'),
                  ],
                },
                resolveJsonModule: true,
                skipLibCheck: true,
                strict: true,
                target: 'ESNext',
                types: ['node', 'react'],
              },
              include: [
                'packages/core-runtime/src/modules/actions/**/*.ts',
                'packages/core-runtime/src/policies/**/*.ts',
                inventoryManifestFile,
                'verticals/inventory-stock/src/actions/**/*.ts',
                'verticals/inventory-stock/src/integrations/**/*.ts',
                'verticals/inventory-stock/shared/outbox/**/*.ts',
                'verticals/billing/src/workers/**/*.ts',
                'verticals/billing/src/worker-host/**/*.ts',
                billingApiIndexFile,
                'verticals/inventory-stock/src/policies/**/*.ts',
                'verticals/inventory-stock/src/routes/**/*.ts',
                'verticals/inventory-stock/src/routes/**/*.tsx',
                'verticals/inventory-stock/src/federation/**/*.tsx',
                'verticals/inventory-stock/src/i18n/**/*.ts',
                'verticals/inventory-stock/api/**/*.ts',
                'verticals/inventory-stock/src/api/**/*.ts',
                'verticals/inventory-stock/shared/apis/**/*.ts',
                'verticals/inventory-stock/src/search/**/*.ts',
                'verticals/inventory-stock/src/reports/**/*.ts',
              ],
            }),
            'utf-8',
          ),
        );

        const result = spawnSync(tscPath, ['-p', fixtureTsconfig], {
          cwd: fixture.root,
          encoding: 'utf-8',
        });
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      }),
    );
  }),
);

it('generated fluent slots preserve nested chains beside independent top-level entries', () => {
  const nestedEntry = `.addHttpApi(
  FirstApi,
  (api) => api
    .addGroup(FirstGroup)
    .addGroup(SecondGroup),
)`;
  const neighborEntry = '.addHttpApi(SecondApi)';
  const addedEntry = '.addHttpApi(ThirdApi)';
  const source = `${GOVERNED_HTTP_API_ADDITION_SLOT_START}
${nestedEntry}
${neighborEntry}
${GOVERNED_HTTP_API_ADDITION_SLOT_END}`;
  expect(
    readGeneratedSlotEntries(source, GOVERNED_HTTP_API_ADDITION_SLOT_START, GOVERNED_HTTP_API_ADDITION_SLOT_END),
  ).toEqual([nestedEntry, neighborEntry]);
  const next = insertSortedSlot(
    source,
    GOVERNED_HTTP_API_ADDITION_SLOT_START,
    GOVERNED_HTTP_API_ADDITION_SLOT_END,
    [addedEntry],
    (entry) => entry === nestedEntry || entry === neighborEntry || entry === addedEntry,
  );
  expect(
    readGeneratedSlotEntries(next, GOVERNED_HTTP_API_ADDITION_SLOT_START, GOVERNED_HTTP_API_ADDITION_SLOT_END),
  ).toEqual([nestedEntry, neighborEntry, addedEntry]);
});

for (const protectedEntry of [
  '.addHttpApi(FirstApi) /*\n.addHttpApi(CommentOnly)\n*/',
  '.addHttpApi(FirstApi) // .addHttpApi(CommentOnly)',
  '.addHttpApi(`text )\n.addHttpApi(StringOnly)\n(`)',
  '.addHttpApi("text )", \'text ]\', /* ) ] }\n.addGroup(CommentOnly)\n*/ FirstApi)',
]) {
  it(`generated fluent slots shield protected text in ${protectedEntry}`, () => {
    const source = `${GOVERNED_HTTP_API_ADDITION_SLOT_START}
${protectedEntry}
.addHttpApi(SecondApi)
${GOVERNED_HTTP_API_ADDITION_SLOT_END}`;
    expect(
      readGeneratedSlotEntries(source, GOVERNED_HTTP_API_ADDITION_SLOT_START, GOVERNED_HTTP_API_ADDITION_SLOT_END),
    ).toEqual([protectedEntry, '.addHttpApi(SecondApi)']);
  });
}

it('generated fluent slots preserve terminated statements and reset tail boundaries', () => {
  const statement = '.addHttpApi(StatementApi)\n.addHttpApi(StatementNeighbor);';
  const tailEntries = ['.addHttpApi(TailApi)', '.addHttpApi(TailNeighbor)'];
  const source = `${GOVERNED_HTTP_API_ADDITION_SLOT_START}
${statement}
${tailEntries.join('\n')}
${GOVERNED_HTTP_API_ADDITION_SLOT_END}`;
  expect(
    readGeneratedSlotEntries(source, GOVERNED_HTTP_API_ADDITION_SLOT_START, GOVERNED_HTTP_API_ADDITION_SLOT_END),
  ).toEqual([statement, ...tailEntries]);
});

it('generated fluent slots preserve nonfluent multiline statement continuations', () => {
  const entries = ['const api = FirstApi\n  .addGroup(FirstGroup);', 'SecondApi,'];
  const source = `${GOVERNED_HTTP_API_ADDITION_SLOT_START}
${entries.join('\n')}
${GOVERNED_HTTP_API_ADDITION_SLOT_END}`;
  expect(
    readGeneratedSlotEntries(source, GOVERNED_HTTP_API_ADDITION_SLOT_START, GOVERNED_HTTP_API_ADDITION_SLOT_END),
  ).toEqual(entries);
});

for (const incompleteEntry of [
  '.addHttpApi(FirstApi',
  '.addHttpApi(FirstApi))',
  '.addHttpApi(FirstApi)\n.addHttpApi(SecondApi',
  '.addHttpApi("FirstApi)',
  '.addHttpApi(FirstApi) /* unclosed',
  'const api = FirstApi\n.addGroup(FirstGroup)',
]) {
  it(`generated fluent slots reject incomplete or unbalanced syntax in ${incompleteEntry}`, () => {
    const source = `${GOVERNED_HTTP_API_ADDITION_SLOT_START}
${incompleteEntry}
${GOVERNED_HTTP_API_ADDITION_SLOT_END}`;
    expect(() =>
      readGeneratedSlotEntries(source, GOVERNED_HTTP_API_ADDITION_SLOT_START, GOVERNED_HTTP_API_ADDITION_SLOT_END),
    ).toThrow(/generated owner slot contains unsupported developer content/u);
  });
}

it('generated fluent slots preserve multiline call entries', () => {
  const source = `${GOVERNED_HTTP_API_ADDITION_SLOT_START}
  .addHttpApi(
    FirstApi,
  )
  .addHttpApi(SecondApi)
  ${GOVERNED_HTTP_API_ADDITION_SLOT_END}`;
  const next = insertSortedSlot(
    source,
    GOVERNED_HTTP_API_ADDITION_SLOT_START,
    GOVERNED_HTTP_API_ADDITION_SLOT_END,
    ['.addHttpApi(ThirdApi)'],
    (entry) => entry.startsWith('.addHttpApi(') && entry.endsWith(')'),
  );
  const entries = readGeneratedSlotEntries(
    next,
    GOVERNED_HTTP_API_ADDITION_SLOT_START,
    GOVERNED_HTTP_API_ADDITION_SLOT_END,
  );
  expect(entries.length).toBe(3);
  expect(entries[0] ?? '').toMatch(/FirstApi/u);
});

for (const [start, end] of [
  [GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_START, GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_END],
  [GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START, GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_END],
] as const) {
  it.live(
    `governed generation accepts the independent support slot without ${start}`,
    Effect.fn(function* mergedScenario95() {
      yield* withFixture(
        Effect.fn(function* mergedScenario94(fixture) {
          const rootPath = path.join(fixture.root, inventoryHandlerRootFile);
          const source = yield* Effect.promise(() => readFile(rootPath, 'utf-8'));
          expect(source.includes(start)).toBeTruthy();
          yield* Effect.promise(() => writeFile(rootPath, source.replace(start, '').replace(end, ''), 'utf-8'));
          yield* run(fixture, scaffoldCommand.moduleApi, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--name',
            fixtureName.resourceDetail,
          ]);
          const generated = yield* Effect.promise(() => readFile(rootPath, 'utf-8'));
          expect(generated).toMatch(/resourceDetailReadApiLive/u);
        }),
      );
    }),
  );
}

it.live(
  'Action identity boundary rejects an owned file without the authentication adapter',
  Effect.fn(function* mergedScenario98() {
    yield* withFixture(
      Effect.fn(function* mergedScenario97(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [scaffoldFlag.vertical, inventorySlug]);
        const serverPath = path.join(fixture.root, inventoryActionPrincipalFile);
        const source = yield* Effect.promise(() => readFile(serverPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(
            serverPath,
            source.replaceAll('authenticateOperationPrincipal', 'removedAuthenticationAdapter'),
            'utf-8',
          ),
        );
        yield* assertScaffoldRefused(
          fixture,
          scaffoldCommand.microverticalActionBoundary,
          [scaffoldFlag.vertical, inventorySlug],
          /refusing|owned|boundary/u,
        );
      }),
    );
  }),
);

it.live(
  'typed injected governed runtime stays bound to the exported owner composition',
  Effect.fn(function* mergedScenario99() {
    const shared = yield* Effect.promise(() => readFile(path.join(appRoot, partyGovernedContractPath), 'utf-8'));
    const handler = yield* Effect.promise(() =>
      readFile(path.join(appRoot, 'verticals/party-registry/api/index.ts'), 'utf-8'),
    );
    expect(hasValidGovernedHttpCompositionRoot(shared, handler)).toBe(true);
    expect(
      hasValidGovernedHttpCompositionRoot(
        shared,
        handler.replace(/readRuntime: Layer\.Layer<\s*ReadRuntime,/u, 'readRuntime: Layer.Layer<UnrelatedRuntime,'),
      ),
    ).toBe(false);
    expect(
      hasValidGovernedHttpCompositionRoot(
        shared,
        handler.replace('handlers: resolvedApiHandlersLive', 'handlers: Layer.empty'),
      ),
    ).toBe(false);
    expect(
      hasValidGovernedHttpCompositionRoot(shared, handler.replace('api: partyRegistryApi,', 'api: unrelatedApi,')),
    ).toBe(false);
    expect(
      hasValidGovernedHttpCompositionRoot(
        shared,
        handler.replace('export default apiRuntime;', 'export default unrelatedRuntime;'),
      ),
    ).toBe(false);
  }),
);

it.live(
  'assembled governed runtime rejects disconnected handler pipelines and counterfeit assemblers',
  Effect.fn(function* mergedScenario100() {
    const shared = yield* Effect.promise(() => readFile(path.join(appRoot, partyGovernedContractPath), 'utf-8'));
    const handler = yield* Effect.promise(() =>
      readFile(path.join(appRoot, 'verticals/party-registry/api/index.ts'), 'utf-8'),
    );
    for (const [before, after] of [
      [
        'const resolvedApiHandlersLive = apiHandlersLive.pipe(',
        'const resolvedApiHandlersLive = unrelatedHandlers.pipe(',
      ],
      ["'@app/shared-contracts/server/effect-bff-runtime'", "'./counterfeit-assembler.ts'"],
      ['handlers: resolvedApiHandlersLive,', 'handlers: unrelatedHandlers,'],
    ] as const) {
      expect(handler.includes(before)).toBeTruthy();
      expect(hasValidGovernedHttpCompositionRoot(shared, handler.replace(before, after))).toBe(false);
    }
  }),
);
