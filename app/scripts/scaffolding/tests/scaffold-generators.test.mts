import { Cause, Predicate } from 'effect';
import { expect, it } from '@app/effect-rstest';
import { NodeServices } from '@effect/platform-node';

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TrustedPrincipalContextSchema } from '../../../packages/core-runtime/src/actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../../../packages/core-runtime/src/actions/principal-context.ts';
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
import {
  GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS,
  GATEWAY_ASSERTION_TTL_SECONDS,
} from '../../../packages/shared-contracts/src/gateway-context.ts';
import { SignJWT, exportJWK, generateKeyPair, generateSecret, importJWK } from 'jose';
import type { JWK } from 'jose';
import {
  issueGatewayContextAssertion,
  makeGatewayIssuerLayer,
} from '../../../apps/shell-super-app/api/auth/gateway-issuer.ts';
import type { GatewayIssuerConfigValue } from '../../../apps/shell-super-app/api/auth/gateway-issuer-config.ts';
import { getHelpText, runScaffoldEffect, ScaffoldingError } from '../cli.mts';
import type { ScaffoldCommand } from '../cli.mts';
import type { JsonValue } from '../shared.mts';
import {
  assertPublishedOutboxDependencyUsage,
  publishedOutboxContractExports,
} from '../../published-outbox-contracts.mts';

const expectFailure = <A, E, R>(self: Effect.Effect<A, E, R>, check: (cause: unknown) => void) =>
  Effect.matchCauseEffect(self, {
    onFailure: (cause) => Effect.sync(() => check(Cause.squash(cause))),
    onSuccess: () =>
      Effect.sync(() => {
        throw new Error('Expected operation to fail');
      }),
  });

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
  readonly verifyActionPrincipal: (
    authorization: string | undefined,
    options: {
      readonly currentTimeSeconds: Effect.Effect<number>;
      readonly environment: GeneratedPrincipalEnvironment;
      readonly redemption: { readonly consume: () => Effect.Effect<void> };
    },
  ) => Effect.Effect<TrustedPrincipalContext, { readonly _tag: GeneratedPrincipalErrorTag }>;
}

interface GeneratedActionGatewayModule {
  readonly makeActionGateway: (
    acquire: (payload: { readonly audience: string }) => Effect.Effect<{ readonly token: string }>,
  ) => {
    readonly invoke: <Success>(
      attempt: (authorization: string) => Effect.Effect<Success>,
    ) => Effect.Effect<Success>;
  };
}

const GeneratedPrincipalModuleSchema = Schema.Struct({
  verifyActionPrincipal: Schema.declare<GeneratedPrincipalModule['verifyActionPrincipal']>(
    (value): value is GeneratedPrincipalModule['verifyActionPrincipal'] =>
      Predicate.isFunction(value),
  ),
});
const GeneratedActionGatewayModuleSchema = Schema.Struct({
  makeActionGateway: Schema.declare<GeneratedActionGatewayModule['makeActionGateway']>(
    (value): value is GeneratedActionGatewayModule['makeActionGateway'] =>
      Predicate.isFunction(value),
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
const asProblemDetails = HttpApiSchema.asJson({ contentType: 'application/problem+json' });
const ActionAuthenticationProblemSchema = Schema.TaggedStruct(
  'ActionAuthenticationProblem',
  problemFields,
).pipe(asProblemDetails, HttpApiSchema.status(401));
const ActionVerificationUnavailableProblemSchema = Schema.TaggedStruct(
  'ActionVerificationUnavailableProblem',
  { ...problemFields, retryable: Schema.Literal(true) },
).pipe(asProblemDetails, HttpApiSchema.status(503));
type EndpointProblem =
  | typeof ActionAuthenticationProblemSchema.Type
  | typeof ActionVerificationUnavailableProblemSchema.Type;
const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);
const failActionAuthentication = () =>
  bearerChallenge.pipe(
    Effect.andThen(
      Effect.fail<EndpointProblem>({
        _tag: 'ActionAuthenticationProblem',
        detail: 'A valid Bearer assertion is required.',
        status: 401,
        title: 'Action authentication required',
        type: 'https://ontos.dev/problems/action-authentication-required',
      }),
    ),
  );
const failActionVerificationUnavailable = () =>
  Effect.fail<EndpointProblem>({
    _tag: 'ActionVerificationUnavailableProblem',
    detail: 'Action identity verification is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'Action verification unavailable',
    type: 'https://ontos.dev/problems/action-verification-unavailable',
  });
const generatedPrincipalErrorHandlers = {
  ActionPrincipalConfigurationError: failActionVerificationUnavailable,
  ActionPrincipalExpiredError: failActionAuthentication,
  ActionPrincipalInvalidError: failActionAuthentication,
  ActionPrincipalMissingError: failActionAuthentication,
  ActionPrincipalScopeError: failActionAuthentication,
  ActionPrincipalUnavailableError: failActionVerificationUnavailable,
};
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
  Schema.decodeUnknownSync(FixturePackageSchema, { onExcessProperty: 'preserve' })(
    JSON.parse(source),
  );
const decodeInventoryLocale = (source: string) =>
  Schema.decodeUnknownSync(InventoryLocaleSchema, { onExcessProperty: 'preserve' })(
    JSON.parse(source),
  );

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
const inventorySearchProviderFile =
  'verticals/inventory-stock/src/search/inventory-items.provider.ts';
const inventorySearchContractFile =
  'verticals/inventory-stock/shared/apis/inventory-items-search.ts';
const inventoryActionPrincipalFile = 'verticals/inventory-stock/api/auth/action-principal.ts';
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
const appRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(import.meta.url);
const createEntry = require.resolve('@modern-js/create');
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
    const pair = yield* Effect.promise(() =>
      generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
    );
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

const writeFixtureFile = (
  root: string,
  relativePath: string,
  content: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* scenario2() {
    const filePath = path.join(root, relativePath);
    yield* Effect.promise(() => mkdir(path.dirname(filePath), { recursive: true }));
    yield* Effect.promise(() => writeFile(filePath, content, 'utf-8'));
  });

const createVertical = (root: string, vertical: FixtureVertical): Effect.Effect<void, unknown> =>
  Effect.gen(function* scenario3() {
    yield* writeFixtureFile(
      root,
      `verticals/${vertical.slug}/module-federation.config.ts`,
      'export default { exposes: {} };\n',
    );
    yield* writeFixtureFile(
      root,
      `verticals/${vertical.slug}/tsconfig.json`,
      json({
        compilerOptions: { composite: true },
        include: ['src', 'shared'],
        references: [],
      }),
    );
    yield* writeFixtureFile(
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
    yield* writeFixtureFile(
      root,
      `verticals/${vertical.slug}/api/index.ts`,
      `export const existingApiRuntime = '${vertical.moduleId}';\n`,
    );
    yield* Effect.all(
      ['cs', 'en'].map(
        Effect.fn(function* scenario4(locale) {
          return yield* writeFixtureFile(
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
      .map((segment, index) =>
        index === 0 ? segment : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`,
      )
      .join('')}I18nResources`;
    yield* writeFixtureFile(
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
    yield* writeFixtureFile(
      root,
      `verticals/${vertical.slug}/src/routes/ultramodern-route-head.tsx`,
      'export const UltramodernRouteHead = () => null;\n',
    );
  });

const createFixture = (): Effect.Effect<Fixture, unknown> =>
  Effect.gen(function* scenario5() {
    const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'ontos-scaffolding-')));
    yield* writeFixtureFile(root, rootPackageFile, json({ name: 'fixture', private: true }));
    yield* writeFixtureFile(
      root,
      coreRuntimeIndexFile,
      `export const existingCoreSurface = true;\n\n// <generated-core-action-exports>\n// </generated-core-action-exports>\n\n// <generated-global-policy-exports>\n// </generated-global-policy-exports>\n`,
    );
    yield* writeFixtureFile(
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
    yield* writeFixtureFile(root, shellSentinelFile, 'export const shell = true;\n');
    yield* writeFixtureFile(
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
    yield* writeFixtureFile(
      root,
      topologyFile,
      json({
        schemaVersion: 1,
        verticals: [inventoryVertical, billingVertical, hrVertical, contactsVertical].map(
          (vertical) => ({
            domain: vertical.namespace,
            id: vertical.appId,
            kind: 'vertical',
            moduleFederation: {
              name: vertical.mfBoundaryId,
              role: 'remote',
            },
            package: `@app/${vertical.slug}`,
            path: `verticals/${vertical.slug}`,
          }),
        ),
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
  run: (fixture: Fixture) => Effect.Effect<void, unknown>,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* scenario7() {
    const fixture = yield* createFixture();
    yield* run(fixture).pipe(
      Effect.ensuring(Effect.promise(() => rm(fixture.root, { force: true, recursive: true }))),
    );
  });

const visitTree = (
  root: string,
  snapshot: Record<string, string>,
  directory: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* scenario9() {
    const entries = yield* Effect.promise(() => readdir(directory, { withFileTypes: true }));
    yield* Effect.all(
      entries
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map(
          Effect.fn(function* scenario10(entry) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
              yield* visitTree(root, snapshot, entryPath);
            } else if (entry.isFile()) {
              snapshot[path.relative(root, entryPath)] = yield* Effect.promise(() =>
                readFile(entryPath, 'utf-8'),
              );
            }
          }),
        ),
      { concurrency: 'unbounded' },
    );
  });

const snapshotTree = Effect.fn(function* scenario8(root: string) {
  const snapshot: Record<string, string> = {};

  yield* visitTree(root, snapshot, root);
  return snapshot;
});

const readFixtureFile = (root: string, relativePath: string): Effect.Effect<string, unknown> =>
  Effect.gen(function* scenario11() {
    return yield* Effect.promise(() => readFile(path.join(root, relativePath), 'utf-8'));
  });

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
      if (
        command === 'action' &&
        flags.includes('--action') &&
        !flags.includes(scaffoldFlag.legalEntityScope)
      ) {
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
        } else if (
          command === scaffoldCommand.microverticalPage ||
          command === scaffoldCommand.moduleApi ||
          command === scaffoldCommand.publicComponent ||
          command === 'report' ||
          command === scaffoldCommand.searchProvider
        ) {
          flags = [
            ...flags,
            scaffoldFlag.authorization,
            'context_permission',
            '--permission',
            'module.access',
          ];
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
    expect(getHelpText(scaffoldCommand.microverticalPage)).toMatch(
      /defaults to \/<vertical>\/<page>/u,
    );
    expect(getHelpText(scaffoldCommand.microverticalPage)).toMatch(/:parameter/u);
    expect(getHelpText(scaffoldCommand.microverticalPage)).toMatch(
      /\/contacts\/customers\/:id\/edit/u,
    );
    expect(getHelpText(scaffoldCommand.externalHttpAdapter)).toMatch(
      /scaffold:external-http-adapter -- --vertical <vertical> --provider <provider> --operation <operation>/u,
    );
    expect(getHelpText(scaffoldCommand.externalHttpAdapter)).toMatch(
      /--vertical contacts --provider ares --operation subject/u,
    );
    expect(getHelpText(scaffoldCommand.searchProviderAccess)).toMatch(
      /--tenant-permission read_party_identity/u,
    );
  }),
);

it.live(
  'search-provider access updates only generated access metadata and fails atomically on drift',
  Effect.fn(function* scenario16() {
    yield* withFixture(
      Effect.fn(function* scenario17(fixture) {
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'verticals/retired/node_modules'), { recursive: true }),
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

        const providerPath = path.join(fixture.root, inventorySearchProviderFile);
        yield* Effect.promise(() =>
          writeFile(
            providerPath,
            `${provider}\n// Owner-customized searchable semantics remain untouched.\n`,
          ),
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
          writeFile(
            providerPath,
            provider.replace('// @generated by OntOS Codesmith ', '// custom '),
          ),
        );
        const beforeRejectedUpdate = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.searchProviderAccess, [
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
          ]),
          (error) => expect(String(error)).toMatch(/Codesmith-owned provider/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeRejectedUpdate);
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
        yield* run(fixture, scaffoldCommand.moduleApi, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--name',
          'party-match',
        ]);
        const sources = yield* Effect.all(
          [inventoryManifestFile, inventoryRegistrationFile].map(
            Effect.fn(function* scenario20(owner) {
              return yield* readFixtureFile(fixture.root, owner);
            }),
          ),
          { concurrency: 'unbounded' },
        );
        for (const source of sources) {
          expect(source.indexOf("'party-match':") < source.indexOf("'party-match-decision':")).toBe(
            true,
          );
        }
      }),
    );
  }),
);

it.live(
  'generated read clients fetch mounted owner URLs and support separately deployed hosts',
  Effect.fn(function* scenario21() {
    yield* withFixture(
      Effect.fn(function* scenario22(fixture) {
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
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'node_modules/@app'), { recursive: true }),
        );
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'node_modules/@modern-js'), { recursive: true }),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/shared-contracts'),
            path.join(fixture.root, 'node_modules/@app/shared-contracts'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, effectNodeModulePath),
            path.join(fixture.root, effectNodeModulePath),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, pluginBffNodeModulePath),
            path.join(fixture.root, pluginBffNodeModulePath),
            'dir',
          ),
        );
        const result = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            `
      import { Effect } from 'effect';
      import { FetchHttpClient } from 'effect/unstable/http';
      import { executeResourceDetail, executeResourceDetailWithAuthorization } from './verticals/inventory-stock/src/api/resource-detail-client.ts';
      import { loadInventoryItemsClient, loadInventoryItemsClientWithAuthorization } from './verticals/inventory-stock/src/api/inventory-items-search-client.ts';
      import { loadStockLevelsClient, loadStockLevelsClientWithAuthorization } from './verticals/inventory-stock/src/api/stock-levels-report-client.ts';
      const calls = [];
      const cases = [
        [executeResourceDetailWithAuthorization, {}, { ok: true }, executeResourceDetail],
        [loadInventoryItemsClientWithAuthorization, { query: 'chair' }, [], loadInventoryItemsClient],
        [loadStockLevelsClientWithAuthorization, { parameters: {} }, { rows: [] }, loadStockLevelsClient],
      ];
      for (const [invoke, payload, response] of cases) {
        const fetch = async (url, init) => {
          calls.push({ url: String(url), method: init.method, authorization: new Headers(init.headers).get('authorization'), correlationId: new Headers(init.headers).get('x-correlation-id') });
          return Response.json(response);
        };
        await Effect.runPromise(invoke(payload, 'Bearer proof', 'correlation-proof', { baseUrl: new URL('https://inventory.example.test/custom/inventory-stock-api') }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
      }
      globalThis.location = { origin: 'https://shell.example.test', pathname: '/cs/inventory' };
      for (const [invoke, payload, response] of cases) {
        await Effect.runPromise(invoke(payload, 'Bearer proof', 'correlation-proof').pipe(Effect.provideService(FetchHttpClient.Fetch, async (url, init) => {
          calls.push({ url: String(url), method: init.method, authorization: new Headers(init.headers).get('authorization'), correlationId: new Headers(init.headers).get('x-correlation-id') });
          return Response.json(response);
        })));
      }
      for (const [, payload, response, invoke] of cases) {
        await Effect.runPromise(invoke(payload, 'correlation-proof', { baseUrl: 'https://inventory.example.test/custom/inventory-stock-api' }).pipe(Effect.provideService(FetchHttpClient.Fetch, async (url, init) => {
          if (String(url) === 'https://shell.example.test/shell-super-app-api/auth/gateway-context') {
            return Response.json({ expiresAt: 2_000_000_000, token: 'proof' });
          }
          calls.push({ url: String(url), method: init.method, authorization: new Headers(init.headers).get('authorization'), correlationId: new Headers(init.headers).get('x-correlation-id') });
          return Response.json(response);
        })));
      }
      console.log(JSON.stringify(calls));
    `,
          ],
          { cwd: fixture.root, encoding: 'utf-8' },
        );
        expect(result.status, result.stderr || result.error?.message).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(
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
      }),
    );
  }),
);

it.live(
  'governed contribution generators patch owner contracts and lazy adapters atomically',
  Effect.fn(function* scenario23() {
    yield* withFixture(
      Effect.fn(function* scenario24(fixture) {
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
        expect(registration).toMatch(
          /import\('\.\/src\/api\/inventory-items-search-client\.ts'\)/u,
        );
        expect(registration).toMatch(/import\('\.\/src\/api\/stock-levels-report-client\.ts'\)/u);
        expect(federation).toMatch(/\.\/InventoryAlerts/u);
        expect(federation).toMatch(/\.\/InventorySummary/u);
        expect(nextManifest).not.toMatch(/import\('/u);
        const searchClient = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/api/inventory-items-search-client.ts',
        );
        const reportClient = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/api/stock-levels-report-client.ts',
        );
        const moduleApiClient = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/api/resource-detail-client.ts',
        );
        const moduleApiContract = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/shared/apis/resource-detail.ts',
        );
        const secondModuleApiContract = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/shared/apis/resource-history.ts',
        );
        const secondModuleApiClient = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/api/resource-history-client.ts',
        );
        const searchProvider = yield* readFixtureFile(fixture.root, inventorySearchProviderFile);
        const reportProvider = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/reports/stock-levels.provider.ts',
        );
        const moduleApiRead = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/api/resource-detail.read.ts',
        );
        const searchServer = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/api/inventory-items-search-server.ts',
        );
        const reportServer = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/api/stock-levels-report-server.ts',
        );
        const moduleApiServer = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/api/resource-detail-read-server.ts',
        );
        const operationBoundary = yield* readFixtureFile(
          fixture.root,
          inventoryActionPrincipalFile,
        );
        expect(searchClient).toMatch(/makeEffectHttpApiClient\(InventoryItemsSearchApi, \{/u);
        expect(reportClient).toMatch(/makeEffectHttpApiClient\(StockLevelsReportApi, \{/u);
        expect(moduleApiContract).toMatch(
          /headers: \{\},\s+params: \{\},\s+payload: ResourceDetailRequestSchema,\s+query: \{\}/u,
        );
        expect(moduleApiClient).toMatch(
          /client\.resourceDetail\.execute\(\{\s+headers: \{\},\s+params: \{\},\s+payload,\s+query: \{\},?\s+\}\)/u,
        );
        expect(moduleApiContract).toMatch(/HttpApiGroup\.make\('resourceDetail'\)/u);
        expect(secondModuleApiContract).toMatch(/HttpApiGroup\.make\('resourceHistory'\)/u);
        expect(secondModuleApiClient).toMatch(/client\.resourceHistory\.execute\(/u);
        for (const client of [moduleApiClient, searchClient, reportClient]) {
          expect(client).toMatch(/Context\.Reference</u);
          expect(client).toMatch(/Effect\.provideService\(/u);
          expect(client).toMatch(
            /prependUrl\(\s*request,\s*\(baseUrl \?\? '\/inventory-stock-api'\)\.toString\(\)/u,
          );
          expect(client).toMatch(/operationGateway\.invoke\(\(authorization\) =>/u);
          expect(client).toMatch(/WithAuthorization/u);
          expect(client).toMatch(
            /setHeaders\(\{\s+authorization,\s+'x-correlation-id': correlationId,?\s+\}\)/u,
          );
        }
        expect(searchClient).not.toMatch(/\.provider\.ts|import\(/u);
        expect(reportClient).not.toMatch(/\.provider\.ts|import\(/u);
        for (const provider of [searchProvider, reportProvider]) {
          expect(provider).toMatch(/defineRead\(/u);
          expect(provider).toMatch(/legalEntityScope: 'required'/u);
          expect(provider).toMatch(/permissionTarget: 'module'/u);
          expect(provider).not.toMatch(/CoreDatabase|ScopedTransactionExecutor|from 'pg'/u);
        }
        expect(searchProvider).toMatch(/result\.map\(\(\{ ref \}\) => ref\)/u);
        expect(moduleApiRead).toMatch(/defineRead\(/u);
        expect(moduleApiRead).toMatch(/legalEntityScope: 'required'/u);
        for (const server of [moduleApiServer, searchServer, reportServer]) {
          expect(server).toMatch(/verifyOperationPrincipal\(\s*request\.headers\.authorization,/u);
          expect(server).toMatch(/yield\* ReadRuntime/u);
          expect(server).toMatch(/\.runRead\(\{/u);
          expect(server).toMatch(/HttpEffect\.appendPreResponseHandler/u);
          expect(server).toMatch(/'www-authenticate', 'Bearer'/u);
          expect(server).toMatch(/Match\.tags\(\{/u);
          expect(server).toMatch(/ReadHandlerNotFound: notFoundProblem/u);
          expect(server).toMatch(
            /ReadPolicyDenied: \(failure\) => policyProblem\(failure\.httpStatus\)/u,
          );
          expect(server).toMatch(/Effect\.catchTags\(\{/u);
          expect(server).not.toMatch(/switch \(error\._tag\)|error\._tag ===/u);
          expect(server).toMatch(/problem\.status === 401\s+\?\s+bearerChallenge/u);
          expect(server).not.toMatch(/tenantId|legalEntityId|principalId|CoreDatabase|from 'pg'/u);
        }
        expect(operationBoundary).toMatch(
          /export const verifyOperationPrincipal = verifyActionPrincipal/u,
        );
        const searchContract = yield* readFixtureFile(fixture.root, inventorySearchContractFile);
        expect(searchContract).toMatch(
          /HttpApiEndpoint\.post\('execute', '\/inventory\.stock\/search\/inventory-items'/u,
        );
        expect(searchContract).not.toMatch(/tenantId|legalEntityId|principalId/u);
        expect(searchContract).toMatch(/PolicyConflictProblem/u);
        expect(searchContract).toMatch(/Schema\.Literal\(409\)/u);

        const beforeRepeat = yield* snapshotTree(fixture.root);
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
        yield* expectFailure(
          run(fixture, scaffoldCommand.moduleApi, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--name',
            '../unsafe',
          ]),
          (error) => expect(String(error)).toMatch(/lower-kebab-case/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeRepeat);
        const billingFederationPath = path.join(
          fixture.root,
          'verticals/billing/module-federation.config.ts',
        );
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
        const commentSafeFederation = yield* Effect.promise(() =>
          readFile(billingFederationPath, 'utf-8'),
        );
        expect(commentSafeFederation).toMatch(/\/exposes: \\\{\\\}\/u/u);
        expect(commentSafeFederation).toMatch(/\.\/BillingSummary/u);
        yield* Effect.promise(() =>
          writeFile(billingFederationPath, 'export default {};\n', 'utf-8'),
        );
        const beforeUnpatchable = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.publicComponent, [
            scaffoldFlag.vertical,
            'billing',
            '--name',
            'billing-details',
          ]),
          (error) => expect(String(error)).toMatch(/exposes object is missing/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeUnpatchable);
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
            [
              scaffoldFlag.vertical,
              inventorySlug,
              '--action',
              fixtureName.action,
              '--unknown',
              'x',
            ],
            /unknown flag --unknown/u,
          ],
          [
            'action',
            [
              scaffoldFlag.vertical,
              inventorySlug,
              '--action',
              fixtureName.action,
              '--action',
              'again',
            ],
            /only once/u,
          ],
          [
            'action',
            [scaffoldFlag.vertical, '', '--action', fixtureName.action],
            /non-empty value/u,
          ],
          [
            'action',
            [scaffoldFlag.vertical, '../billing', '--action', fixtureName.action],
            /lower-kebab-case/u,
          ],
          [
            'action',
            [scaffoldFlag.vertical, '/absolute/billing', '--action', fixtureName.action],
            /lower-kebab-case/u,
          ],
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
            [
              '--scope',
              'other',
              '--module',
              fixtureName.actionModule,
              '--action',
              fixtureName.action,
            ],
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
          [
            scaffoldCommand.microverticalActionBoundary,
            [scaffoldFlag.vertical, '../billing'],
            /lower-kebab-case/u,
          ],
          [
            'policy',
            [
              '--scope',
              'global',
              '--policy',
              fixtureName.policy,
              scaffoldFlag.vertical,
              inventorySlug,
            ],
            /forbidden/u,
          ],
          ['policy', ['--scope', 'microvertical', '--policy', fixtureName.policy], /required/u],
          [
            'policy',
            ['--scope', 'other', '--policy', fixtureName.policy],
            /global or microvertical/u,
          ],
          [
            scaffoldCommand.outboxMessage,
            [
              scaffoldFlag.vertical,
              inventorySlug,
              '--action',
              fixtureName.action,
              '--topic',
              'Not.Safe',
            ],
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
  Effect.fn(function* scenario28() {
    yield* withFixture(
      Effect.fn(function* scenario29(fixture) {
        const shellBefore = yield* readFixtureFile(fixture.root, shellSentinelFile);
        const topologyBefore = yield* readFixtureFile(fixture.root, topologyFile);
        const result = yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [
          scaffoldFlag.vertical,
          inventorySlug,
        ]);
        expect(result.kind).toBe('generated');
        const server = yield* readFixtureFile(fixture.root, inventoryActionPrincipalFile);
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
        expect(server).not.toMatch(
          /createLocalJWKSet|decodeProtectedHeader|jwtVerify|PublicVerificationKeySchema/u,
        );
        expect(client).toMatch(/acquire\(\{ audience: ACTION_GATEWAY_AUDIENCE \}/u);
        expect(client).not.toMatch(/localStorage|sessionStorage/u);
        expect(server).toMatch(/verifyAndRedeem/u);
        expect(redemption).toMatch(/GatewayAssertionRedemptionUnavailableError/u);
        const packageJson = decodeFixturePackage(
          yield* readFixtureFile(fixture.root, inventoryPackageFile),
        );
        expect(packageJson.dependencies).toEqual({
          '@app/core-runtime': workspaceVersion,
          '@app/gateway-principal-verifier': workspaceVersion,
          '@app/shared-contracts': workspaceVersion,
          effect: '4.0.0-beta.107',
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
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [
          scaffoldFlag.vertical,
          inventorySlug,
        ]);
        const afterFirstRun = yield* snapshotTree(fixture.root);
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [
          scaffoldFlag.vertical,
          inventorySlug,
        ]);
        expect(yield* snapshotTree(fixture.root)).toEqual(afterFirstRun);
      }),
    );
    yield* withFixture(
      Effect.fn(function* scenario32(fixture) {
        yield* writeFixtureFile(
          fixture.root,
          inventoryActionPrincipalFile,
          `// Owner-authored identity adapter
export const ownerCode = true;
`,
        );
        const before = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.microverticalActionBoundary, [
            scaffoldFlag.vertical,
            inventorySlug,
          ]),
          (error) => expect(String(error)).toMatch(/refusing to overwrite existing business file/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
      }),
    );
  }),
);

it.live(
  'generated verifier executes real Shell assertions and overlapping Ed25519 rotation',
  Effect.fn(function* scenario33() {
    yield* withFixture(
      Effect.fn(function* scenario34(fixture) {
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [
          scaffoldFlag.vertical,
          inventorySlug,
        ]);
        yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [
          scaffoldFlag.vertical,
          'billing',
        ]);
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'node_modules', '@app'), { recursive: true }),
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
            path.join(appRoot, 'packages/shared-contracts'),
            path.join(fixture.root, 'node_modules/@app/shared-contracts'),
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
          Schema.decodeUnknownSync(EsbuildMetafileSchema)(
            JSON.parse(yield* Effect.promise(() => readFile(edgeMetafile, 'utf-8'))),
          ).inputs,
        ).join('\n');
        expect(edgeInputs).not.toMatch(
          /core-runtime\/src\/(?:auth|db)|node:(?:crypto|path)|\/pg\//u,
        );
        const generatedModule = Schema.decodeUnknownSync(GeneratedPrincipalModuleSchema)(
          yield* Effect.promise(
            () => import(pathToFileURL(path.join(fixture.root, inventoryActionPrincipalFile)).href),
          ),
        );
        const billingGeneratedModule = Schema.decodeUnknownSync(GeneratedPrincipalModuleSchema)(
          yield* Effect.promise(
            () =>
              import(
                pathToFileURL(
                  path.join(fixture.root, 'verticals/billing/api/auth/action-principal.ts'),
                ).href
              ),
          ),
        );
        const generatedClientModule = Schema.decodeUnknownSync(GeneratedActionGatewayModuleSchema)(
          yield* Effect.promise(
            () => import(pathToFileURL(path.join(fixture.root, inventoryActionGatewayFile)).href),
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
        const issue = Effect.fn(function* scenario35(
          configuration: GatewayIssuerConfigValue,
          issuedAt: number,
          audience: string = inventorySlug,
        ) {
          return yield* issueGatewayContextAssertion({ audience, principal }).pipe(
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
        const verify = (
          token: string,
          override: GeneratedPrincipalEnvironment = environment,
          now = 1_700_000_001,
        ) =>
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
          (error) =>
            expect(isGeneratedPrincipalError('ActionPrincipalScopeError')(error)).toBe(true),
        );
        yield* expectFailure(
          billingGeneratedModule.verifyActionPrincipal(`Bearer ${currentAssertion.token}`, {
            currentTimeSeconds: Effect.succeed(1_700_000_001),
            environment,
            redemption: testRedemption,
          }),
          (error) =>
            expect(isGeneratedPrincipalError('ActionPrincipalScopeError')(error)).toBe(true),
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
            Effect.fn(function* scenario37(jwks) {
              return yield* expectFailure(
                verify(currentAssertion.token, {
                  ...environment,
                  ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify(jwks),
                }),
                (error) =>
                  expect(
                    isGeneratedPrincipalError('ActionPrincipalConfigurationError')(error),
                  ).toBe(true),
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
          (error) =>
            expect(isGeneratedPrincipalError('ActionPrincipalConfigurationError')(error)).toBe(
              true,
            ),
        );
        yield* expectFailure(
          verify(
            retiringAssertion.token,
            {
              ...environment,
              ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [current.publicJwk] }),
            },
            1_700_000_000 +
              GATEWAY_ASSERTION_TTL_SECONDS +
              GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS +
              1,
          ),
          (error) =>
            expect(isGeneratedPrincipalError('ActionPrincipalInvalidError')(error)).toBe(true),
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
        const signingKey = yield* Effect.promise(() =>
          importJWK(current.configuration.privateJwk, 'EdDSA'),
        );
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
          (error) =>
            expect(isGeneratedPrincipalError('ActionPrincipalMissingError')(error)).toBe(true),
        );
        yield* expectFailure(
          generatedModule.verifyActionPrincipal('bearer malformed', {
            currentTimeSeconds: Effect.succeed(1_700_000_001),
            environment,
            redemption: testRedemption,
          }),
          (error) =>
            expect(isGeneratedPrincipalError('ActionPrincipalInvalidError')(error)).toBe(true),
        );
        yield* expectFailure(
          generatedModule.verifyActionPrincipal(`Bearer ${currentAssertion.token}`, {
            currentTimeSeconds: Effect.succeed(1_700_000_001),
            environment: {},
            redemption: testRedemption,
          }),
          (error) =>
            expect(isGeneratedPrincipalError('ActionPrincipalConfigurationError')(error)).toBe(
              true,
            ),
        );
        let acquisitions = 0;
        const authorizations: string[] = [];
        const idempotencyKey = 'caller-owned-idempotency-key';
        const actionGateway = generatedClientModule.makeActionGateway(({ audience }) => {
          acquisitions += 1;
          expect(audience).toBe(inventorySlug);
          return Effect.succeed({ token: `attempt-${acquisitions}` });
        });
        const attempt = (authorization: string) => {
          authorizations.push(authorization);
          return Effect.succeed(idempotencyKey);
        };
        expect(yield* actionGateway.invoke(attempt)).toBe(idempotencyKey);
        expect(yield* actionGateway.invoke(attempt)).toBe(idempotencyKey);
        expect(authorizations).toEqual(['Bearer attempt-1', 'Bearer attempt-2']);

        const actionApi = HttpApi.make('generatedActionIdentityFixture').add(
          HttpApiGroup.make('action').add(
            HttpApiEndpoint.post('invoke', '/actions/invoke', {
              error: [
                ActionAuthenticationProblemSchema,
                ActionVerificationUnavailableProblemSchema,
              ],
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
              .pipe(
                Effect.tap(markActionReached),
                Effect.catchTags(generatedPrincipalErrorHandlers),
              ),
          ),
        );
        const actionRuntime = defineEffectBff({
          api: actionApi,
          layer: HttpApiBuilder.layer(actionApi).pipe(Layer.provide(actionGroupLive)),
        });
        const actionHandler = actionRuntime.createHandler();
        yield* Effect.gen(function* useResource2() {
          const missingResponse = yield* Effect.promise(() =>
            actionHandler.handler(new Request(actionInvokeUrl, { method: 'POST' })),
          );
          expect(missingResponse.status).toBe(401);
          expect(missingResponse.headers.get('www-authenticate')).toBe('Bearer');
          expect(missingResponse.headers.get('content-type') ?? '').toMatch(
            /application\/problem\+json/u,
          );
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
            Schema.decodeUnknownSync(RetryableProblemSchema)(
              yield* Effect.promise(() => unavailableResponse.json()),
            ).retryable,
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
        }).pipe(Effect.ensuring(Effect.promise(() => actionHandler.dispose())));
      }),
    );
  }),
);

it.live(
  'generates one self-contained typed fail-closed Action and preserves package metadata',
  Effect.fn(function* scenario38() {
    yield* withFixture(
      Effect.fn(function* scenario39(fixture) {
        yield* run(fixture, 'action', [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          'create-order2',
        ]);
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
        const packageJson = decodeFixturePackage(
          yield* readFixtureFile(fixture.root, inventoryPackageFile),
        );
        expect(packageJson.dependencies).toEqual({
          '@app/core-runtime': workspaceVersion,
          zeta: '1.0.0',
        });
        expect(packageJson.scripts['existing']).toBe(preservedFixtureValue);
        const beforeRerun = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, 'action', [
            scaffoldFlag.vertical,
            inventorySlug,
            '--action',
            'create-order2',
          ]),
          (error) => expect(String(error)).toMatch(/refusing to overwrite/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeRerun);
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
        const beforeRerun = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.actionService, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--service',
            'inventory-persistence',
          ]),
          (error) => expect(String(error)).toMatch(/refusing to overwrite/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeRerun);
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
        const adapterPath = path.join(
          fixture.root,
          'verticals/contacts/src/integrations/ares/ares-subject.service.ts',
        );
        expect(result).toEqual({
          kind: 'generated',
          result: { adapterPath },
        });
        const after = yield* snapshotTree(fixture.root);
        const changedPaths = new Set([
          ...Object.keys(before).filter((file) => before[file] !== after[file]),
          ...Object.keys(after).filter((file) => before[file] !== after[file]),
        ]);
        expect([...changedPaths]).toEqual([
          'verticals/contacts/src/integrations/ares/ares-subject.service.ts',
        ]);
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

export class AresSubjectService extends Context.Service<
  AresSubjectService,
  AresSubjectServiceContract
>()('@app/contacts/integrations/ares/ares-subject/AresSubjectService') {}

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
        const source =
          after['verticals/contacts/src/integrations/ares/ares-subject.service.ts'] ?? '';
        expect(source).toMatch(/HttpClient\.HttpClient/u);
        expect(source).toMatch(/Layer\.effect/u);
        expect(source).not.toMatch(
          /fetch\(|httpClient\.(?:execute|get|head|post|patch|put|del|options)\(|https?:\/\//u,
        );

        const beforeOverwrite = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.externalHttpAdapter, [
            scaffoldFlag.vertical,
            'contacts',
            scaffoldFlag.provider,
            'ares',
            scaffoldFlag.operation,
            'subject',
          ]),
          (error) => expect(String(error)).toMatch(/refusing to overwrite/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeOverwrite);
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
          [
            [scaffoldFlag.vertical, 'contacts', scaffoldFlag.operation, 'subject'],
            /missing required flag --provider/u,
          ],
          [
            [scaffoldFlag.vertical, 'contacts', scaffoldFlag.provider, 'ares'],
            /missing required flag --operation/u,
          ],
          [
            [scaffoldFlag.provider, 'ares', scaffoldFlag.operation, 'subject'],
            /missing required flag --vertical/u,
          ],
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
            [
              scaffoldFlag.vertical,
              'contacts',
              scaffoldFlag.provider,
              'Ares',
              scaffoldFlag.operation,
              'subject',
            ],
            /provider must be canonical lower-kebab-case/u,
          ],
          [
            [
              scaffoldFlag.vertical,
              'contacts',
              scaffoldFlag.provider,
              'ares',
              scaffoldFlag.operation,
              'Subject',
            ],
            /operation must be canonical lower-kebab-case/u,
          ],
          [
            [
              scaffoldFlag.vertical,
              'contacts',
              scaffoldFlag.provider,
              'src',
              scaffoldFlag.operation,
              'subject',
            ],
            /provider must be canonical lower-kebab-case/u,
          ],
          [
            [
              scaffoldFlag.vertical,
              'contacts',
              scaffoldFlag.provider,
              'ares',
              scaffoldFlag.operation,
              'node_modules',
            ],
            /operation must be canonical lower-kebab-case/u,
          ],
          [
            [
              scaffoldFlag.vertical,
              'contacts',
              scaffoldFlag.provider,
              '../ares',
              scaffoldFlag.operation,
              'subject',
            ],
            /provider must be canonical lower-kebab-case/u,
          ],
          [
            [
              scaffoldFlag.vertical,
              'contacts',
              scaffoldFlag.provider,
              'ares',
              scaffoldFlag.operation,
              '../subject',
            ],
            /operation must be canonical lower-kebab-case/u,
          ],
          [
            [
              scaffoldFlag.vertical,
              'missing',
              scaffoldFlag.provider,
              'ares',
              scaffoldFlag.operation,
              'subject',
            ],
            /package metadata is missing/u,
          ],
        ];
        for (const [generatorArguments, expected] of invalidCalls) {
          yield* expectFailure(
            run(fixture, scaffoldCommand.externalHttpAdapter, generatorArguments),
            (error) => expect(String(error)).toMatch(expected),
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
            manifest.replace(
              '// @generated by OntOS Codesmith Module Contract v1',
              '// developer-owned manifest',
            ),
            'utf-8',
          ),
        );
        const before = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.externalHttpAdapter, [
            scaffoldFlag.vertical,
            'contacts',
            scaffoldFlag.provider,
            'ares',
            scaffoldFlag.operation,
            'subject',
          ]),
          (error) => expect(String(error)).toMatch(/is not a generated module owner/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
      }),
    );

    yield* withFixture(
      Effect.fn(function* scenario49(fixture) {
        yield* writeFixtureFile(
          fixture.root,
          'verticals/contacts/src/integrations',
          'planner fixture blocks the required directory\n',
        );
        const before = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.externalHttpAdapter, [
            scaffoldFlag.vertical,
            'contacts',
            scaffoldFlag.provider,
            'ares',
            scaffoldFlag.operation,
            'subject',
          ]),
          (error) => expect(String(error)).toMatch(/ENOTDIR|not a directory/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
        const before = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, 'action', [
            scaffoldFlag.vertical,
            inventorySlug,
            '--action',
            'create-order3',
          ]),
          (error) =>
            expect(String(error)).toMatch(
              /generated owner slot contains unsupported developer content/u,
            ),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
        const accountExport =
          "export { accountChangeAction } from './modules/actions/account-change.action.ts';";
        const zExport =
          "export { zLastChangeAction } from './modules/actions/z-last-change.action.ts';";
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
          coreCatalog.indexOf('accountChangeAction.descriptor,') <
            coreCatalog.indexOf('zLastChangeAction.descriptor,'),
        ).toBe(true);
        expect(coreCatalog).toMatch(/export const existingCatalogSurface = true/u);

        const beforeOverwrite = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, 'action', [
            '--scope',
            'core',
            '--module',
            fixtureName.actionModule,
            '--action',
            'account-change',
          ]),
          (error) => expect(String(error)).toMatch(/refusing to overwrite/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeOverwrite);
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
        const before = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, 'action', [
            '--scope',
            'core',
            '--module',
            fixtureName.actionModule,
            '--action',
            fixtureName.action,
          ]),
          (error) =>
            expect(String(error)).toMatch(/generated owner file does not contain one valid/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
        const before = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, 'action', [
            '--scope',
            'core',
            '--module',
            fixtureName.actionModule,
            '--action',
            fixtureName.action,
          ]),
          (error) => expect(String(error)).toMatch(/unsupported developer content/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
        const before = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, 'action', [
            '--scope',
            'core',
            '--module',
            fixtureName.actionModule,
            '--action',
            fixtureName.action,
          ]),
          (error) => expect(String(error)).toMatch(/unsupported developer content/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
        const packageJson = decodeFixturePackage(
          yield* Effect.promise(() => readFile(packagePath, 'utf-8')),
        );
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
        const before = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, 'action', [
            scaffoldFlag.vertical,
            inventorySlug,
            '--action',
            fixtureName.action,
          ]),
          (error) => expect(String(error)).toMatch(/incompatible/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
        const billingPackage = decodeFixturePackage(
          yield* Effect.promise(() => readFile(billingPackagePath, 'utf-8')),
        );
        yield* Effect.promise(() =>
          writeFile(
            billingPackagePath,
            json({
              ...billingPackage,
              modernjs: { ...billingPackage.modernjs, appId: inventoryVertical.appId },
            }),
            'utf-8',
          ),
        );
        const before = yield* snapshotTree(fixture.root);

        yield* expectFailure(
          run(fixture, 'action', [
            scaffoldFlag.vertical,
            inventorySlug,
            '--action',
            fixtureName.action,
          ]),
          (error) => expect(String(error)).toMatch(/duplicate generated appId inventory-stock/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
        const packageJson = decodeFixturePackage(
          yield* Effect.promise(() => readFile(packagePath, 'utf-8')),
        );
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
        const before = yield* snapshotTree(fixture.root);

        yield* expectFailure(
          run(fixture, 'action', [
            scaffoldFlag.vertical,
            inventorySlug,
            '--action',
            fixtureName.action,
          ]),
          (error) =>
            expect(String(error)).toMatch(
              /must have exactly one matching generated topology entry/u,
            ),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
        const packageJson = decodeFixturePackage(
          yield* Effect.promise(() => readFile(packagePath, 'utf-8')),
        );
        const styledPackage = JSON.stringify(packageJson, null, 4).replaceAll('\n', '\r\n');
        yield* Effect.promise(() => writeFile(packagePath, styledPackage, 'utf-8'));

        yield* run(fixture, 'action', [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
        ]);

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
        yield* run(fixture, 'action', [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
        ]);
        const actionPath = path.join(fixture.root, inventoryActionFile);
        const generatedAction = yield* Effect.promise(() => readFile(actionPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(
            actionPath,
            `${generatedAction}\nexport const developerOwned = true;\n`,
            'utf-8',
          ),
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
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/inventory-stock/outbox/orders-created';
import type { OutboxPayload } from '@app/inventory-stock/outbox/orders-created';

export const CreateOrderOrdersCreatedOutboxPayloadSchema = OutboxPayloadSchema;
export type CreateOrderOrdersCreatedOutboxPayload = OutboxPayload;
export const CreateOrderOrdersCreatedOutboxProducerModuleKey = outboxProducerModuleKey;
export const CreateOrderOrdersCreatedOutboxTopic = outboxTopic;

export const createCreateOrderOrdersCreatedOutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
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
        const producerPackage = decodeFixturePackage(
          yield* readFixtureFile(fixture.root, inventoryPackageFile),
        );
        expect(producerPackage.exports['./outbox/orders-created']).toBe(
          generatedOutboxContractPath,
        );
        const action = yield* Effect.promise(() => readFile(actionPath, 'utf-8'));
        const createdExport =
          "export { CreateOrderOrdersCreatedOutboxPayloadSchema } from './create-order.orders-created.outbox-message.ts';";
        const shippedExport =
          "export { CreateOrderOrdersShippedOutboxPayloadSchema } from './create-order.orders-shipped.outbox-message.ts';";
        expect(action.indexOf(createdExport) < action.indexOf(shippedExport)).toBe(true);
        expect(action).toMatch(/export const developerOwned = true;/u);
        expect(message).not.toMatch(
          /addDomainEvent|addOutboxMessage|subjectResource|transport|worker/u,
        );

        yield* run(fixture, scaffoldCommand.outboxMessage, [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
          '--topic',
          'events.foo-1-bar',
        ]);
        const beforeIdentifierCollision = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.outboxMessage, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--action',
            fixtureName.action,
            '--topic',
            'events.foo1-bar',
          ]),
          (error) =>
            expect(String(error)).toMatch(
              /Outbox identifier CreateOrderEventsFoo1BarOutbox already exists/u,
            ),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeIdentifierCollision);
      }),
    );
  }),
);

it.live(
  'rejects missing, handwritten, duplicate, and normalized-collision Outbox targets without partial writes',
  Effect.fn(function* scenario67() {
    yield* withFixture(
      Effect.fn(function* scenario68(fixture) {
        const beforeMissing = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.outboxMessage, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--action',
            'missing-action',
            '--topic',
            fixtureName.ordersCreated,
          ]),
          (error) => expect(String(error)).toMatch(/requires the generated Action/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeMissing);

        yield* writeFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/actions/handwritten.action.ts',
          `// <generated-outbox-message-exports>\n// </generated-outbox-message-exports>\n`,
        );
        const beforeHandwritten = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.outboxMessage, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--action',
            'handwritten',
            '--topic',
            fixtureName.ordersCreated,
          ]),
          (error) => expect(String(error)).toMatch(/only the matching generated Action/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeHandwritten);

        yield* run(fixture, 'action', [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
        ]);
        const governedActionPath = inventoryActionFile;
        const governedAction = yield* readFixtureFile(fixture.root, governedActionPath);
        yield* writeFixtureFile(
          fixture.root,
          governedActionPath,
          governedAction.replace("      access: 'write',", "      access: 'read',"),
        );
        const beforeMismatchedEntrypoint = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.outboxMessage, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--action',
            fixtureName.action,
            '--topic',
            fixtureName.ordersCreated,
          ]),
          (error) =>
            expect(String(error)).toMatch(
              /matching generated Action with its governed write entrypoint/u,
            ),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeMismatchedEntrypoint);
        yield* writeFixtureFile(fixture.root, governedActionPath, governedAction);
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
  Effect.fn(function* scenario70() {
    yield* withFixture(
      Effect.fn(function* scenario71(fixture) {
        yield* run(fixture, 'action', [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
        ]);
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
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/inventory-stock/outbox/orders-created';

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

export const outboxWorkerLayer = Layer.merge(
  OutboxWorkerInfrastructureLive,
  outboxWorkerHandlerLayer,
);
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
import {
  extractOutboxWorkerSubscriptions,
  startOutboxWorkerProcess,
} from '@app/core-runtime/outbox/worker';
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
        expect(yield* readFixtureFile(fixture.root, billingApiIndexFile)).toBe(
          "export const existingApiRuntime = 'billing.core';\n",
        );
        const consumerPackage = decodeFixturePackage(
          yield* readFixtureFile(fixture.root, 'verticals/billing/package.json'),
        );
        expect(consumerPackage.dependencies['@app/core-runtime']).toBe(workspaceVersion);
        expect(consumerPackage.dependencies[inventoryPackageName]).toBe(workspaceVersion);
        expect(consumerPackage.exports['./workers']).toBe(undefined);
        expect(consumerPackage.scripts['dev:worker']).toBe(workerStartScript);
        expect(consumerPackage.scripts['worker:start']).toBe(workerStartScript);
        const consumerTsconfig = Schema.decodeUnknownSync(FixtureTsconfigSchema)(
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
          registry.indexOf('ordersCreatedLoggerWorker') <
            registry.indexOf('ordersShippedProjectorWorker'),
        ).toBe(true);
        const beforeRerun = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.outboxWorker, [
            scaffoldFlag.vertical,
            'billing',
            '--worker',
            fixtureName.ordersCreatedLogger,
            scaffoldFlag.producer,
            inventorySlug,
            '--topic',
            fixtureName.ordersCreated,
          ]),
          (error) => expect(String(error)).toMatch(/refusing to overwrite/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeRerun);
      }),
    );
  }),
);

it.live(
  'generates self-consuming Outbox Workers without circular project or package dependencies',
  Effect.fn(function* scenario72() {
    yield* withFixture(
      Effect.fn(function* scenario73(fixture) {
        yield* run(fixture, 'action', [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
        ]);
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
        const registry = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/workers/index.ts',
        );
        const hostLayer = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/worker-host/layer.ts',
        );
        const hostMain = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/worker-host/main.ts',
        );
        const hostScript = yield* readFixtureFile(
          fixture.root,
          'verticals/inventory-stock/scripts/outbox-worker.ts',
        );
        expect(registry.includes(workerRegistryEntry)).toBe(true);
        expect(hostLayer.includes('OutboxWorkerInfrastructureLive')).toBe(true);
        expect(hostMain.includes('startInventoryStockOutboxWorker();')).toBe(true);
        expect(hostScript.includes('startOutboxWorkerProcess({')).toBe(true);
        const registration = yield* readFixtureFile(fixture.root, inventoryRegistrationFile);
        expect(registration.includes('createOrderAction,')).toBe(true);
        expect(registration.includes(workerRegistryEntry)).toBe(true);
        expect(yield* readFixtureFile(fixture.root, inventoryManifestFile)).toBe(manifestBefore);
        expect(yield* readFixtureFile(fixture.root, inventoryTsconfigFile)).toBe(tsconfigBefore);
        const ownerPackage = decodeFixturePackage(
          yield* readFixtureFile(fixture.root, inventoryPackageFile),
        );
        expect(ownerPackage.dependencies['@app/core-runtime']).toBe(workspaceVersion);
        expect(ownerPackage.dependencies[inventoryPackageName]).toBe(undefined);
        expect(ownerPackage.exports['./outbox/orders-created']).toBe(generatedOutboxContractPath);
        for (const script of ['dev:worker', 'worker:start']) {
          expect(ownerPackage.scripts[script]).toBe(workerStartScript);
        }
        const beforeRerun = yield* snapshotTree(fixture.root);
        yield* expectFailure(run(fixture, scaffoldCommand.outboxWorker, args), (error) =>
          expect(String(error)).toMatch(/refusing to overwrite/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeRerun);
        yield* run(fixture, 'action', [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          'request-rebuild',
        ]);
        const registrationAfterAction = yield* readFixtureFile(
          fixture.root,
          inventoryRegistrationFile,
        );
        expect(registrationAfterAction.includes('requestRebuildAction,')).toBe(true);
        expect(registrationAfterAction.includes(workerRegistryEntry)).toBe(true);
        yield* writeFixtureFile(
          fixture.root,
          inventoryTsconfigFile,
          JSON.stringify({ references: [{ path: '../inventory-stock' }] }),
        );
        const beforeCircularReference = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.outboxWorker, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--worker',
            'orders-created-audit',
            scaffoldFlag.producer,
            inventorySlug,
            '--topic',
            fixtureName.ordersCreated,
          ]),
          (error) => expect(String(error)).toMatch(/circular self project reference/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeCircularReference);
      }),
    );
  }),
);

it.live(
  'refuses unpublished or malformed Outbox contracts without partial consumer writes',
  Effect.fn(function* scenario74() {
    yield* withFixture(
      Effect.fn(function* scenario75(fixture) {
        const beforeUnpublished = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.outboxWorker, [
            scaffoldFlag.vertical,
            'billing',
            '--worker',
            fixtureName.ordersLogger,
            scaffoldFlag.producer,
            inventorySlug,
            '--topic',
            'orders.missing',
          ]),
          (error) =>
            expect(String(error)).toMatch(/published producer Outbox contract is missing/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeUnpublished);

        yield* run(fixture, 'action', [
          scaffoldFlag.vertical,
          inventorySlug,
          '--action',
          fixtureName.action,
        ]);
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
            validContract.replace(
              '// @ontos-outbox-producer inventory.stock',
              '// @ontos-outbox-producer billing',
            ),
            'utf-8',
          ),
        );
        const beforeMalformed = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.outboxWorker, [
            scaffoldFlag.vertical,
            'billing',
            '--worker',
            fixtureName.ordersLogger,
            scaffoldFlag.producer,
            inventorySlug,
            '--topic',
            fixtureName.ordersCreated,
          ]),
          (error) => expect(String(error)).toMatch(/owner\/topic\/schema mismatch/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeMalformed);
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

        expect(
          yield* readFixtureFile(
            fixture.root,
            'packages/core-runtime/src/policies/tenant-active.policy.ts',
          ),
        ).toBe(`import { Effect } from 'effect';
import { defineGlobalPolicy, denyPolicy } from '../actions/policy.ts';

export const tenantActivePolicy = defineGlobalPolicy<unknown>({
  evaluate: () =>
    Effect.fail(
      denyPolicy('policy_not_implemented', 'The Tenant Active Policy is not implemented'),
    ),
  policyKey: 'global.tenant-active.v1',
});
`);
        expect(
          yield* readFixtureFile(
            fixture.root,
            'verticals/inventory-stock/src/policies/stock-available.policy.ts',
          ),
        ).toBe(`import { Effect } from 'effect';
import { defineMicroverticalPolicy, denyPolicy } from '@app/core-runtime';

export const stockAvailablePolicy = defineMicroverticalPolicy<unknown, 'inventory.stock'>({
  evaluate: () =>
    Effect.fail(
      denyPolicy('policy_not_implemented', 'The Stock Available Policy is not implemented'),
    ),
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
          decodeFixturePackage(yield* readFixtureFile(fixture.root, inventoryPackageFile))
            .dependencies['@app/core-runtime'],
        ).toBe(workspaceVersion);
        const beforeDuplicate = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, 'policy', ['--scope', 'global', '--policy', fixtureName.policy]),
          (error) => expect(String(error)).toMatch(/refusing to overwrite/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeDuplicate);

        yield* run(fixture, 'policy', ['--scope', 'global', '--policy', 'foo-1-bar']);
        const beforeIdentifierCollision = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, 'policy', ['--scope', 'global', '--policy', 'foo1-bar']),
          (error) =>
            expect(String(error)).toMatch(/Policy identifier foo1BarPolicy already exists/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeIdentifierCollision);
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
          writeFile(
            englishLocalePath,
            '{\r\n    "inventory": {"existing":"en-preserved"}\r\n}',
            'utf-8',
          ),
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
        expect(federation).toMatch(
          /'\.\/PagePurchaseOrders': '\.\/src\/federation\/page-purchase-orders\.tsx'/u,
        );
        expect(federatedPage).toMatch(/<FederatedI18nBoundary/u);
        expect(federatedPage).toMatch(/resources=\{inventoryStockI18nResources\}/u);
        expect(shellClients).toMatch(
          /appId: 'inventory-stock', componentKey: 'inventory\.stock\.page-purchase-orders', load: \(\) => import\('inventoryStock\/PagePurchaseOrders'\)/u,
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
        const english = decodeInventoryLocale(englishContent);
        const czech = decodeInventoryLocale(
          yield* readFixtureFile(
            fixture.root,
            'verticals/inventory-stock/locales/cs/inventory.json',
          ),
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
        yield* run(fixture, scaffoldCommand.microverticalPage, [
          scaffoldFlag.vertical,
          'hr',
          '--page',
          'people',
        ]);
        yield* Effect.promise(() =>
          stat(path.join(fixture.root, 'verticals/hr/src/routes/[lang]/hr/people/page.tsx')),
        );
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
          mkdir(path.join(fixture.root, 'node_modules', '@modern-js'), { recursive: true }),
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
        yield* writeFixtureFile(
          fixture.root,
          'node_modules/@modern-js/plugin-i18n/package.json',
          json({
            exports: { './runtime': './runtime.tsx' },
            name: '@modern-js/plugin-i18n',
            type: 'module',
          }),
        );
        yield* writeFixtureFile(
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
          [
            runnerPath,
            '--bundle',
            '--format=cjs',
            '--jsx=automatic',
            '--platform=node',
            `--outfile=${bundlePath}`,
          ],
          { cwd: fixture.root, encoding: 'utf-8' },
        );
        expect(bundle.status, bundle.stderr || bundle.error?.message).toBe(0);
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
          yield* readFixtureFile(
            fixture.root,
            'apps/shell-super-app/src/routes/[lang]/purchasing/orders/page.data.ts',
          ),
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
        expect(yield* readFixtureFile(fixture.root, inventoryManifestFile)).toMatch(
          /routePath: '\/orders'/u,
        );
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
              const before = yield* snapshotTree(fixture.root);
              yield* expectFailure(
                run(fixture, scaffoldCommand.microverticalPage, [
                  scaffoldFlag.vertical,
                  inventorySlug,
                  '--page',
                  'orders',
                  '--url',
                  url,
                ]),
                (error) => expect(String(error)).toMatch(/--url/u),
              );
              expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
        yield* writeFixtureFile(
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

        const ownerRoute =
          'verticals/inventory-stock/src/routes/[lang]/contacts/customers/[id]/edit';
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
        expect(page).toMatch(
          /id: Schema\.String\.pipe\(Schema\.brand\('CustomerEditPageIdRouteParameter'\)\)/u,
        );
        expect(page).toMatch(
          /export type CustomerEditPageRouteParams = typeof CustomerEditPageRouteParams\.Type/u,
        );
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
        expect(shellLoader).toMatch(
          /routeParams: selectRouteParams\(params, routeParameterNames\)/u,
        );
        expect(yield* readFixtureFile(fixture.root, inventoryEnglishLocaleFile)).toMatch(
          /"customerEdit"/u,
        );
        expect(
          yield* readFixtureFile(
            fixture.root,
            'verticals/inventory-stock/locales/cs/inventory.json',
          ),
        ).toMatch(/"customerEdit"/u);

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
        const ownerRoute =
          'verticals/inventory-stock/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]';
        const shellRoute =
          'apps/shell-super-app/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]';

        yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);

        const page = yield* readFixtureFile(fixture.root, `${ownerRoute}/page.tsx`);
        const ownerMetadata = yield* readFixtureFile(fixture.root, `${ownerRoute}/route.meta.ts`);
        const shellLoader = yield* readFixtureFile(fixture.root, `${shellRoute}/page.data.ts`);
        const shellMetadata = yield* readFixtureFile(fixture.root, `${shellRoute}/route.meta.ts`);
        const manifest = yield* readFixtureFile(fixture.root, inventoryManifestFile);

        expect(page).toMatch(/export const ContactDetailPageRouteParams = Schema\.Struct/u);
        expect(page).toMatch(
          /id: Schema\.String\.pipe\(Schema\.brand\('ContactDetailPageIdRouteParameter'\)\)/u,
        );
        expect(page).toMatch(
          /contactId: Schema\.String\.pipe\(Schema\.brand\('ContactDetailPageContactIdRouteParameter'\)\)/u,
        );
        expect(page).toMatch(
          /export type ContactDetailPageRouteParams = typeof ContactDetailPageRouteParams\.Type/u,
        );
        expect(page).toMatch(/Schema\.toStandardSchemaV1\(\s*ContactDetailPageRouteParams,?\s*\)/u);
        expect(ownerMetadata).toMatch(
          /canonicalPath: '\/contacts\/customers\/:id\/contacts\/:contactId'/u,
        );
        expect(shellMetadata).toMatch(
          /canonicalPath: '\/contacts\/customers\/:id\/contacts\/:contactId'/u,
        );
        expect(manifest).toMatch(/routePath: '\/contacts\/customers\/:id\/contacts\/:contactId'/u);
        expect(manifest).toMatch(/inventory\.stock\.page\.contact-detail/u);
        expect(manifest).not.toMatch(/inventory\.stock\.navigation\.contact-detail/u);
        expect(shellLoader).toMatch(/const routeParameterNames = \['id', 'contactId'\] as const;/u);
        expect(shellLoader).toMatch(
          /routeParams: selectRouteParams\(params, routeParameterNames\)/u,
        );
        yield* Effect.promise(() => stat(path.join(fixture.root, ownerRoute)));
        yield* Effect.promise(() => stat(path.join(fixture.root, shellRoute)));

        const afterFirstRun = yield* snapshotTree(fixture.root);
        yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
        expect(yield* snapshotTree(fixture.root)).toEqual(afterFirstRun);
      }),
    );

    yield* withFixture(
      Effect.fn(function* scenario99(fixture) {
        yield* writeFixtureFile(
          fixture.root,
          'apps/shell-super-app/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]/page.tsx',
          'export default function DeveloperOwnedPage() { return null; }\n',
        );
        const before = yield* snapshotTree(fixture.root);

        yield* expectFailure(
          run(fixture, scaffoldCommand.microverticalPage, generatorArguments),
          (error) => expect(String(error)).toMatch(/refusing to overwrite|already exists/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
              const before = yield* snapshotTree(fixture.root);
              yield* expectFailure(
                run(fixture, scaffoldCommand.microverticalPage, [
                  scaffoldFlag.vertical,
                  inventorySlug,
                  '--page',
                  fixtureName.customerEditPage,
                  '--url',
                  url,
                ]),
                (error) => expect(String(error)).toMatch(/--url/u),
              );
              expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, [
                scaffoldFlag.vertical,
                inventorySlug,
                '--page',
                fixtureName.customerEditPage,
                '--url',
                '/inventory/customers/:customerId',
              ]),
              (error) =>
                expect(String(error)).toMatch(/routing collision|already registered|collides/u),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
            yield* Effect.promise(() =>
              writeFile(pagePath, `${pageSource}\n// developer edit\n`, 'utf-8'),
            );
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, generatorArguments),
              (error) => expect(String(error)).toMatch(/collides/u),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
          }),
        ),
        withFixture(
          Effect.fn(function* scenario105(fixture) {
            yield* writeFixtureFile(
              fixture.root,
              'verticals/inventory-stock/src/routes/[lang]/inventory/customers/[id]/edit/page.tsx',
              'export default function PartialPage() { return null; }\n',
            );
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, [
                scaffoldFlag.vertical,
                inventorySlug,
                '--page',
                fixtureName.customerEditPage,
                '--url',
                customerEditUrl,
              ]),
              (error) => expect(String(error)).toMatch(/collides with nested content/u),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, [
                scaffoldFlag.vertical,
                inventorySlug,
                '--page',
                fixtureName.customerEditPage,
                '--url',
                customerDetailUrl,
              ]),
              (error) => expect(String(error)).toMatch(/static route segment|collides/u),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
              rm(
                path.join(
                  fixture.root,
                  'apps/shell-super-app/src/routes/[lang]/shared/customers/[id]/edit',
                ),
                { recursive: true },
              ),
            );
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, [
                scaffoldFlag.vertical,
                inventorySlug,
                '--page',
                fixtureName.customerEditPage,
                '--url',
                '/shared/customers/:id/edit',
              ]),
              (error) => expect(String(error)).toMatch(/already registered by billing/u),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
        yield* writeFixtureFile(
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
            path.join(
              fixture.root,
              'apps/shell-super-app/src/routes/[lang]/inventory/customers/[id]/edit/page.tsx',
            ),
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
            yield* writeFixtureFile(
              fixture.root,
              'apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx',
              'export default function ModulePage() { return null; }\n',
            );
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, [
                scaffoldFlag.vertical,
                inventorySlug,
                '--page',
                'customers',
                '--url',
                '/modules/customers',
              ]),
              (error) =>
                expect(String(error)).toMatch(/collides with dynamic route segment \[moduleId\]/u),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
          }),
        ),
        withFixture(
          Effect.fn(function* scenario112(fixture) {
            yield* writeFixtureFile(
              fixture.root,
              'apps/shell-super-app/src/routes/[lang]/login/page.tsx',
              'export default function LoginPage() { return null; }\n',
            );
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, [
                scaffoldFlag.vertical,
                inventorySlug,
                '--page',
                'customers',
                '--url',
                '/login/customers',
              ]),
              (error) => expect(String(error)).toMatch(/reserved route prefix \/login/u),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
              rm(
                path.join(fixture.root, 'apps/shell-super-app/src/routes/[lang]/shared/customers'),
                {
                  recursive: true,
                },
              ),
            );
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, [
                scaffoldFlag.vertical,
                inventorySlug,
                '--page',
                'customer-list',
                '--url',
                '/shared/customers',
              ]),
              (error) => expect(String(error)).toMatch(/already registered by billing/u),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
          stat(
            path.join(
              fixture.root,
              'verticals/inventory-stock/src/routes/[lang]/inventory-stock/order/page.tsx',
            ),
          ),
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
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, [
                scaffoldFlag.vertical,
                inventorySlug,
                '--page',
                'orders',
                '--url',
                '/second/orders',
              ]),
              (error) =>
                expect(String(error)).toMatch(
                  /page identity inventory\.stock\.page\.orders already exists/u,
                ),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
          }),
        ),
        withFixture(
          Effect.fn(function* scenario117(fixture) {
            const generatorArguments = [scaffoldFlag.vertical, inventorySlug, '--page', 'orders'];
            yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
            const manifestPath = path.join(fixture.root, inventoryManifestFile);
            const manifest = yield* Effect.promise(() => readFile(manifestPath, 'utf-8'));
            yield* Effect.promise(() =>
              writeFile(manifestPath, manifest.replace('order: 100', 'order: 101'), 'utf-8'),
            );
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, generatorArguments),
              (error) => expect(String(error)).toMatch(/already exists|collides/u),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, generatorArguments),
              (error) => expect(String(error)).toMatch(/already exists|collides/u),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
                federation.replace(
                  "'./src/federation/page-orders.tsx'",
                  "'./src/federation/page-other.tsx'",
                ),
                'utf-8',
              ),
            );
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, generatorArguments),
              (error) => expect(String(error)).toMatch(/already exists|collides/u),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
          }),
        ),
        withFixture(
          Effect.fn(function* scenario120(fixture) {
            const generatorArguments = [scaffoldFlag.vertical, inventorySlug, '--page', 'orders'];
            yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
            yield* writeFixtureFile(
              fixture.root,
              'apps/shell-super-app/src/routes/[lang]/inventory-stock/orders/developer-note.ts',
              'export const developerNote = true;\n',
            );
            const before = yield* snapshotTree(fixture.root);
            yield* expectFailure(
              run(fixture, scaffoldCommand.microverticalPage, generatorArguments),
              (error) => expect(String(error)).toMatch(/already exists|collides/u),
            );
            expect(yield* snapshotTree(fixture.root)).toEqual(before);
          }),
        ),
      ],
      { concurrency: 'unbounded' },
    );
  }),
);

it.live(
  'migrates only exact legacy generated page output and then reruns as a no-op',
  Effect.fn(function* scenario121() {
    yield* withFixture(
      Effect.fn(function* scenario122(fixture) {
        const generatorArguments = [
          scaffoldFlag.vertical,
          inventorySlug,
          '--page',
          'orders',
          '--url',
          '/orders',
        ];
        yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
        yield* writeFixtureFile(
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
        yield* writeFixtureFile(
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
            Effect.fn(function* scenario123(locale) {
              const localePath = path.join(
                fixture.root,
                `verticals/inventory-stock/locales/${locale}/inventory.json`,
              );
              const catalog = decodeInventoryLocale(
                yield* Effect.promise(() => readFile(localePath, 'utf-8')),
              );
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
              const nextCatalog = Schema.decodeUnknownSync(Schema.Json)({
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

        yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
        const migratedPage = yield* readFixtureFile(fixture.root, inventoryOrdersRouteFile);
        expect(migratedPage).not.toMatch(/\.description|\.empty|<main/u);
        expect(
          yield* readFixtureFile(
            fixture.root,
            'apps/shell-super-app/src/routes/[lang]/orders/page.data.ts',
          ),
        ).toMatch(/entrypointKey: 'inventory\.stock\.page\.orders'/u);
        const migratedEnglish = decodeInventoryLocale(
          yield* readFixtureFile(fixture.root, inventoryEnglishLocaleFile),
        );
        expect(migratedEnglish.inventory.pages['orders']).toEqual({
          description: pagePlaceholder,
          title: 'New Page',
        });
        const afterMigration = yield* snapshotTree(fixture.root);
        yield* run(fixture, scaffoldCommand.microverticalPage, generatorArguments);
        expect(yield* snapshotTree(fixture.root)).toEqual(afterMigration);
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
        const packageJson = decodeFixturePackage(
          yield* Effect.promise(() => readFile(packagePath, 'utf-8')),
        );
        yield* Effect.promise(() =>
          writeFile(
            packagePath,
            json({
              ...packageJson,
              exports: { ...packageJson.exports, './locales/de': './locales/de/inventory.json' },
            }),
            'utf-8',
          ),
        );
        yield* writeFixtureFile(
          fixture.root,
          'verticals/inventory-stock/locales/de/inventory.json',
          json({ inventory: { existing: 'de-preserved' } }),
        );
        const before = yield* snapshotTree(fixture.root);

        yield* expectFailure(
          run(fixture, scaffoldCommand.microverticalPage, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--page',
            fixtureName.purchaseOrdersPage,
          ]),
          (error) => expect(String(error)).toMatch(/no starter translation for locale de/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(before);
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
          rm(
            path.join(
              fixture.root,
              'verticals/inventory-stock/src/routes/ultramodern-route-head.tsx',
            ),
          ),
        );
        const beforeMissingHead = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.microverticalPage, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--page',
            'orders',
          ]),
          (error) => expect(String(error)).toMatch(/UltramodernRouteHead is missing/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeMissingHead);
      }),
    );

    yield* withFixture(
      Effect.fn(function* scenario128(fixture) {
        yield* writeFixtureFile(
          fixture.root,
          'verticals/inventory-stock/src/routes/[lang]/inventory-stock/orders/nested.ts',
          'export {};\n',
        );
        const beforeCollision = yield* snapshotTree(fixture.root);
        yield* expectFailure(
          run(fixture, scaffoldCommand.microverticalPage, [
            scaffoldFlag.vertical,
            inventorySlug,
            '--page',
            'orders',
          ]),
          (error) => expect(String(error)).toMatch(/collides with nested content/u),
        );
        expect(yield* snapshotTree(fixture.root)).toEqual(beforeCollision);
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
                Effect.fail(new ScaffoldingError({ message: 'route refresh fixture failure' })),
              workspaceRoot: fixture.root,
            },
          ).pipe(Effect.provide(NodeServices.layer)),
          (error) => expect(String(error)).toMatch(/route refresh fixture failure/u),
        );
        yield* Effect.promise(() =>
          stat(
            path.join(
              fixture.root,
              'verticals/inventory-stock/src/routes/[lang]/inventory-stock/orders/page.tsx',
            ),
          ),
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

const runCombinedScenario = (
  fixture: Fixture,
): Effect.Effect<Readonly<Record<string, string>>, unknown> =>
  Effect.gen(function* scenario130() {
    yield* addInventoryItemResourceType(fixture);
    yield* run(fixture, scaffoldCommand.microverticalActionBoundary, [
      scaffoldFlag.vertical,
      inventorySlug,
    ]);
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
    yield* run(fixture, 'action', [
      scaffoldFlag.vertical,
      inventorySlug,
      '--action',
      fixtureName.action,
    ]);
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
        Object.entries(yield* snapshotTree(first.root)).filter(([file]) =>
          file.startsWith('verticals/billing/'),
        ),
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
  Effect.fn(function* scenario132() {
    yield* withFixture(
      Effect.fn(function* scenario133(fixture) {
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
          inventoryActionGatewayFile,
          'verticals/inventory-stock/shared/apis/resource-detail.ts',
          'verticals/inventory-stock/src/api/resource-detail.read.ts',
          'verticals/inventory-stock/src/api/resource-detail-client.ts',
          'verticals/inventory-stock/api/resource-detail-read-server.ts',
          inventorySearchContractFile,
          inventorySearchProviderFile,
          'verticals/inventory-stock/src/api/inventory-items-search-client.ts',
          'verticals/inventory-stock/api/inventory-items-search-server.ts',
          'verticals/inventory-stock/shared/apis/stock-levels-report.ts',
          'verticals/inventory-stock/src/reports/stock-levels.provider.ts',
          'verticals/inventory-stock/src/api/stock-levels-report-client.ts',
          'verticals/inventory-stock/api/stock-levels-report-server.ts',
        ];

        yield* Effect.all(
          generatedFiles.map(
            Effect.fn(function* scenario134(relativePath) {
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
  Effect.fn(function* scenario135() {
    yield* withFixture(
      Effect.fn(function* scenario136(fixture) {
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
          mkdir(path.join(fixture.root, 'node_modules', '@authzed'), { recursive: true }),
        );
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'node_modules', '@effect'), { recursive: true }),
        );
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'node_modules', '@modern-js'), { recursive: true }),
        );
        yield* Effect.promise(() =>
          mkdir(path.join(fixture.root, 'node_modules', '@types'), { recursive: true }),
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
            path.join(appRoot, 'packages/core-runtime/node_modules/@effect/sql-pg'),
            path.join(fixture.root, 'node_modules/@effect/sql-pg'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/node_modules/@effect/platform-node'),
            path.join(fixture.root, 'node_modules/@effect/platform-node'),
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
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/node_modules/drizzle-orm'),
            path.join(fixture.root, 'node_modules/drizzle-orm'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/node_modules/dotenv'),
            path.join(fixture.root, 'node_modules/dotenv'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/node_modules/pg'),
            path.join(fixture.root, 'node_modules/pg'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/node_modules/@authzed/authzed-node'),
            path.join(fixture.root, 'node_modules/@authzed/authzed-node'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'apps/shell-super-app/node_modules/@modern-js/plugin-i18n'),
            path.join(fixture.root, 'node_modules/@modern-js/plugin-i18n'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'apps/shell-super-app/node_modules/@modern-js/plugin-bff'),
            path.join(fixture.root, pluginBffNodeModulePath),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'apps/shell-super-app/node_modules/@types/react'),
            path.join(fixture.root, 'node_modules/@types/react'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/node_modules/@types/pg'),
            path.join(fixture.root, 'node_modules/@types/pg'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'node_modules/@types/node'),
            path.join(fixture.root, 'node_modules/@types/node'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/src/actions'),
            path.join(fixture.root, 'packages/core-runtime/src/actions'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/src/db'),
            path.join(fixture.root, 'packages/core-runtime/src/db'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/src/operations'),
            path.join(fixture.root, 'packages/core-runtime/src/operations'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/src/database'),
            path.join(fixture.root, 'packages/core-runtime/src/database'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/src/environment'),
            path.join(fixture.root, 'packages/core-runtime/src/environment'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/src/permissions'),
            path.join(fixture.root, 'packages/core-runtime/src/permissions'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/src/auth'),
            path.join(fixture.root, 'packages/core-runtime/src/auth'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/src/authorization'),
            path.join(fixture.root, 'packages/core-runtime/src/authorization'),
            'dir',
          ),
        );
        yield* Effect.promise(() =>
          symlink(
            path.join(appRoot, 'packages/core-runtime/src/modules/module-entrypoint.ts'),
            path.join(fixture.root, 'packages/core-runtime/src/modules/module-entrypoint.ts'),
            'file',
          ),
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
            Effect.fn(function* scenario137(moduleFile) {
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
                  '@app/core-runtime/outbox/worker': [
                    path.join(appRoot, 'packages/core-runtime/src/outbox/worker-entrypoint.ts'),
                  ],
                  '@app/gateway-principal-verifier/server': [
                    path.join(appRoot, 'packages/gateway-principal-verifier/src/server.ts'),
                  ],
                  '@app/inventory-stock/outbox/*': [
                    './verticals/inventory-stock/shared/outbox/*.ts',
                  ],
                  '@app/shared-contracts': [
                    path.join(appRoot, 'packages/shared-contracts/src/index.ts'),
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
