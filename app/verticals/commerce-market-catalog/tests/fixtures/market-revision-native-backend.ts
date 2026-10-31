import {
  DatabaseConfig,
  parseDatabaseConfig,
  OwnerAuthorizationOverlay,
  ReadRuntime,
  ActionRuntime,
  runAction,
  bindSelfApiKeyAction,
  ActiveApplicationCompositionSnapshotSchema,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import {
  makeModuleContractFixture,
  makeApplicationCompositionSnapshotFixture,
} from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices, NodeHttpServer } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import {
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import {
  makeApiKeyGatewayNativeComposition,
  makeApiKeyGatewayNativeFixture,
  sealApiKeyGatewayNativeComposition,
} from '@app/shell-super-app/testing/api-key-gateway-native';
import { makeCurrentStorefrontNativeReceiver } from '@app/storefront-registry/testing/current-storefront-native';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import type { MarketDefinitionRevisionRef } from '../../shared/resources/market-definition-revision.ts';
import { createMarketAction } from '../../src/actions/create-market.action.ts';
import { reviseMarketDefinitionAction } from '../../src/actions/revise-market-definition.action.ts';
import { associateStorefrontAction } from '../../src/actions/associate-storefront.action.ts';
import { suspendMarketAction } from '../../src/actions/suspend-market.action.ts';
import { currentMarketCatalogRead } from '../../src/api/current-market-catalog.read.ts';
import { pricingCurrentMarketEvidenceRead } from '../../src/api/pricing-current-market-evidence.read.ts';
import { marketHistoryRead } from '../../src/api/market-history.read.ts';
import {
  COMMERCE_MARKET_CATALOG_TABLES,
  gatewayAssertionRedemptions,
  commerceMarketCatalogRelations,
} from '../../src/database/schema.ts';
import { pathToFileURL } from 'node:url';
import { resolveEffectBffModuleHandler } from '@modern-js/bff-effect/effect';
import { defineEffectBff, dispatchEffectBffRequest } from '@modern-js/bff-effect/effect-edge';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { commerceMarketCatalogApiRuntimeFromContext } from '../../api/index.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { commerceMarketCatalogApiContract } from '../../shared/api.ts';

export const marketRevisionNativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const marketAppId = 'commerce-market-catalog' as const;
const registryModuleId = 'commerce.storefront-registry' as const;
const storefrontAppId = 'native-storefront' as const;
const moduleKey = 'commerce.market-catalog';
const databaseObservationSchema = Schema.Struct({ observedAt: Schema.DateTimeUtcFromString });
const shift = (at: DateTime.Utc, millis: number) => DateTime.makeUnsafe(DateTime.toEpochMillis(at) + millis);
const wirePeriod = (startsAt: DateTime.Utc, endsAt?: DateTime.Utc) =>
  endsAt === undefined
    ? { startsAt: DateTime.formatIso(startsAt) }
    : { endsAt: DateTime.formatIso(endsAt), startsAt: DateTime.formatIso(startsAt) };
const actionKeys = [
  createMarketAction,
  reviseMarketDefinitionAction,
  associateStorefrontAction,
  suspendMarketAction,
].map((registration) => registration.descriptor.actionKey);

export class MarketRevisionNativeIssueUnavailable extends Schema.TaggedError<MarketRevisionNativeIssueUnavailable>()(
  'MarketRevisionNativeIssueUnavailable',
  { stage: Schema.Literals(['INPUT_SCOPE_INVALID', 'SHELL_GATEWAY_UNAVAILABLE', 'ADMISSION_MISMATCH']) },
) {}

const MarketRevisionNativeUnavailable = Schema.TaggedError<{
  readonly _tag: 'MarketRevisionNativeUnavailable';
  readonly reason: string;
}>()('MarketRevisionNativeUnavailable', { reason: Schema.String });
const unavailable = () =>
  new MarketRevisionNativeUnavailable({ reason: 'The owned Market revision fixture is unavailable' });

const makeScenario = Effect.fn('MarketRevisionNative.makeScenario')(function* makeScenario(
  withRegistry: boolean,
  marketBaseUrl: string,
) {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1250-market-revision',
  });
  yield* isolated.migrateCoreSchema();
  const filesystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* filesystem.makeTempDirectoryScoped({ prefix: 'ontos-market-revision-empty-' });
  const configurationPath = path.join(temporary, 'drizzle.config.mjs');
  yield* filesystem.writeFileString(
    configurationPath,
    `export default {
    dialect: 'postgresql', out: process.env.ONTOS_MARKET_REVISION_MIGRATIONS,
    schema: process.env.ONTOS_MARKET_REVISION_SCHEMA,
    dbCredentials: { url: process.env.DATABASE_ADMIN_URL },
    migrations: { schema: 'drizzle', table: '__drizzle_migrations_commerce_market_catalog' }
  };`,
  );
  const migrateOwner = Effect.fn('MarketRevisionNative.migrateOwner')(function* migrateOwner() {
    const child = yield* ChildProcess.make(
      'mise',
      [
        'exec',
        '--',
        'pnpm',
        '--filter',
        '@app/commerce-market-catalog',
        'exec',
        'drizzle-kit',
        'migrate',
        '--config',
        configurationPath,
      ],
      {
        cwd: new URL('../../', pathToFileURL(`${process.cwd()}/`)).pathname,
        env: {
          DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
          DATABASE_URL: isolated.connections.runtime.connectionString,
          ONTOS_MARKET_REVISION_MIGRATIONS: `${process.cwd()}/drizzle`,
          ONTOS_MARKET_REVISION_SCHEMA: `${process.cwd()}/src/database/schema.ts`,
        },
        extendEnv: true,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    );
    // Migration diagnostics can contain URLs; drain both pipes without disclosing credentials.
    const [status] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
      concurrency: 3,
    });
    if (Number(status) !== 0) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  });
  yield* migrateOwner();
  const databaseServices = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const admin = yield* makeWithDefaults({ relations: commerceMarketCatalogRelations }).pipe(
    Effect.provide(databaseServices),
  );
  const runtimeRole = sql.identifier(isolated.connections.runtime.user);
  // Fixture-only business table access supports scoped inspection and append-only guard controls.
  // Pre-authentication replay storage retains exactly its production SELECT/INSERT/DELETE privileges.
  yield* admin.execute(sql`grant usage on schema commerce_market_catalog to ${runtimeRole}`, 'objects');
  yield* Effect.forEach(
    COMMERCE_MARKET_CATALOG_TABLES.filter((table) => table !== gatewayAssertionRedemptions),
    (table) => admin.execute(sql`grant select,insert,update,delete on table ${table} to ${runtimeRole}`, 'objects'),
    { concurrency: 1 },
  );
  yield* admin.execute(
    sql`grant select,insert,delete on table ${gatewayAssertionRedemptions} to ${runtimeRole}`,
    'objects',
  );
  const [replayPrivileges] = yield* admin.execute<{
    readonly canDelete: boolean;
    readonly canInsert: boolean;
    readonly canSelect: boolean;
    readonly canUpdate: boolean;
  }>(
    sql`select
    has_table_privilege(${isolated.connections.runtime.user}, 'commerce_market_catalog.gateway_assertion_redemptions', 'DELETE') as "canDelete",
    has_table_privilege(${isolated.connections.runtime.user}, 'commerce_market_catalog.gateway_assertion_redemptions', 'INSERT') as "canInsert",
    has_table_privilege(${isolated.connections.runtime.user}, 'commerce_market_catalog.gateway_assertion_redemptions', 'SELECT') as "canSelect",
    has_table_privilege(${isolated.connections.runtime.user}, 'commerce_market_catalog.gateway_assertion_redemptions', 'UPDATE') as "canUpdate"`,
    'objects',
  );
  if (
    replayPrivileges === undefined ||
    !replayPrivileges.canDelete ||
    !replayPrivileges.canInsert ||
    !replayPrivileges.canSelect ||
    replayPrivileges.canUpdate
  ) {
    return yield* unavailable();
  }
  const registry = withRegistry ? yield* makeCurrentStorefrontNativeReceiver() : undefined;
  const baseSnapshot =
    registry === undefined
      ? yield* makeApplicationCompositionSnapshotFixture([marketAppId], 'market-effective-revision')
      : yield* makeApiKeyGatewayNativeComposition(
          [
            makeModuleContractFixture({
              appId: marketAppId,
              buildMarker: ultramodernApiMarker.buildMarker,
              moduleId: moduleKey,
            }),
            makeModuleContractFixture({
              appId: registry.deployment.appId,
              buildMarker: registry.deployment.buildMarker,
              moduleId: registryModuleId,
            }),
          ],
          3_600_000,
        );
  const snapshot =
    registry === undefined
      ? baseSnapshot
      : {
          ...baseSnapshot,
          composition: sealApiKeyGatewayNativeComposition({
            ...baseSnapshot.composition,
            modules: baseSnapshot.composition.modules.map((module) => {
              if (module.deployment.appId === marketAppId) {
                return { ...module, backend: { baseUrl: marketBaseUrl, transport: 'node-http' as const } };
              }
              if (module.deployment.appId === registry.deployment.appId) {
                return { ...module, backend: { baseUrl: registry.baseUrl, transport: 'node-http' as const } };
              }
              return module;
            }),
          }),
        };
  yield* isolated.publishInitialComposition(snapshot);
  const shell =
    registry === undefined
      ? undefined
      : yield* makeApiKeyGatewayNativeFixture({
          ownedDatabase: isolated,
          snapshotJson: yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
            snapshot,
          ),
        });
  if (registry !== undefined) {
    yield* registry.migrate({
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    });
  }
  const baseConfiguration = {
    actionKeys: [
      ...actionKeys,
      bindSelfApiKeyAction.descriptor.actionKey,
      'commerce.storefront-registry.register-storefront-application',
    ],
    adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
    allowedAudiences: [marketAppId, 'storefront-registry'],
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    compositionRevision: snapshot.composition.revision,
    moduleKeys: [moduleKey, registryModuleId],
    runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
  };
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture(
      shell === undefined
        ? baseConfiguration
        : { ...baseConfiguration, managerProviderSubjectId: shell.providerUserId },
    ),
    (value) => value.close().pipe(Effect.orDie),
  );
  const crypto = yield* Crypto.Crypto;
  const [marketId, secondMarketId, associationId] = yield* Effect.all([
    crypto.randomUUIDv4(),
    crypto.randomUUIDv4(),
    crypto.randomUUIDv4(),
  ]);
  const marketRef = {
    moduleId: moduleKey,
    resourceId: marketId,
    resourceType: 'commerce.market-catalog.market',
    tenantId: fixture.tenantId,
  } as const;
  const secondMarketRef = { ...marketRef, resourceId: secondMarketId };
  const sellerRef = {
    moduleId: 'core.identity',
    resourceId: fixture.legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId: fixture.tenantId,
  } as const;
  const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
  const root = {
    moduleId: moduleKey,
    resourceId: fixture.legalEntityId,
    resourceType: 'commerce.market-catalog.market-catalog-root',
  };
  yield* fixture.grantResourceAccess(root, fixture.manager.principalId, 'writer');
  yield* fixture.grantResourceAccess(marketRef, fixture.manager.principalId, 'writer');
  yield* fixture.grantResourceAccess(secondMarketRef, fixture.manager.principalId, 'writer');
  // Exact test-owned admission. Real Core scope/resource permissions and owner SQL remain active.
  // This does not activate a production provider, default API adapter or publication authority.
  const authorization = Layer.succeed(OwnerAuthorizationOverlay, {
    authorize: (_transaction, input) =>
      Effect.succeed(
        input.scope.tenantId === fixture.tenantId &&
          input.scope.principalId === fixture.manager.principalId &&
          (input.scope.legalEntityId === fixture.legalEntityId || input.scope.legalEntityId === undefined) &&
          ((input.owningModuleKey === moduleKey &&
            input.scope.legalEntityId === fixture.legalEntityId &&
            (actionKeys.includes(input.operationKey) ||
              [currentMarketCatalogRead, pricingCurrentMarketEvidenceRead, marketHistoryRead].some(
                (registration) => registration.descriptor.readKey === input.operationKey,
              ))) ||
            (shell !== undefined &&
              input.owningModuleKey === 'core.identity' &&
              input.operationKey === bindSelfApiKeyAction.descriptor.actionKey) ||
            (registry !== undefined &&
              input.owningModuleKey === registryModuleId &&
              [
                'commerce.storefront-registry.register-storefront-application',
                'commerce.storefront-registry.api.current-storefront-application',
              ].includes(input.operationKey)))
          ? ('allowed' as const)
          : ('unavailable' as const),
      ),
  });
  if (registry !== undefined) {
    yield* fixture.grantResourceAccess(
      {
        moduleId: registryModuleId,
        resourceId: storefrontAppId,
        resourceType: 'commerce.storefront-registry.storefront-application',
      },
      fixture.manager.principalId,
      'writer',
    );
  }
  // Build scoped Core clients once; retained Registry callbacks use this same live context.
  const baseContext = yield* Layer.build(fixture.layer.pipe(Layer.provide(authorization)));
  const binding =
    shell === undefined ? undefined : yield* shell.issueAndBind(principal).pipe(Effect.provideContext(baseContext));
  const context =
    shell === undefined || binding === undefined
      ? baseContext
      : Context.add(
          baseContext,
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY: Redacted.value(binding.secret),
            ONTOS_SHELL_GATEWAY_BASE_URL: shell.baseUrl,
          }),
        );
  const storefront =
    registry === undefined || shell === undefined
      ? undefined
      : yield* registry
          .activate({
            compositionRevision: snapshot.composition.revision,
            compositionSourceUrl: shell.compositionSourceUrl,
            issuer: shell.issuer,
            principal,
            publicJwks: shell.publicJwks,
            storefrontAppId,
          })
          .pipe(Effect.provideContext(context));
  // Derive the native timeline from the same PostgreSQL clock as the owner observation.
  // A virtual process clock cannot advance this authority, and host clocks may be skewed.
  const databaseNow = Effect.fn('MarketRevisionNative.databaseNow')(function* databaseNow() {
    const [row] = yield* admin.execute<typeof databaseObservationSchema.Encoded>(
      sql`select to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "observedAt"`,
      'objects',
    );
    if (row === undefined) {
      return yield* unavailable();
    }
    return (yield* Schema.decodeEffect(databaseObservationSchema)(row)).observedAt;
  });
  const now = yield* databaseNow();
  const startsAt = shift(now, -3_600_000);
  if (storefront !== undefined) {
    yield* storefront
      .register({
        allowedChannels: ['B2C'],
        effectiveInterval: { effectiveFrom: DateTime.formatIso(startsAt) },
        lifecycle: 'ACTIVE',
        reason: 'Native Market revision proof',
        storefrontAppId,
      })
      .pipe(Effect.provideContext(context));
  }
  const revisedAt = shift(now, -1_800_000);
  const before = shift(revisedAt, -1);
  const after = shift(revisedAt, 1);
  const create = (endsAt?: DateTime.Utc, second = false) =>
    runAction({
      payload: {
        channels: ['B2C'],
        effectivePeriod: wirePeriod(startsAt, endsAt),
        jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
        lifecycle: 'ACTIVE',
        marketCode: second ? 'CZ_SECOND' : 'CZ_PRIMARY',
        marketId: second ? secondMarketId : marketId,
        purpose: 'Original commercial meaning',
        reason: 'Native revision regression',
        sellingLegalEntityRef: sellerRef,
        supportedLocales: ['cs-CZ'],
      },
      principal,
      registration: createMarketAction,
      transport: {
        correlationId: second ? 'market-create-second' : 'market-create',
        idempotencyKey: second ? 'create-second' : 'create',
      },
    }).pipe(Effect.provideContext(context));
  const revise = (
    basis: { readonly definitionRevisionRef: MarketDefinitionRevisionRef; readonly revision: number },
    effectiveAt = revisedAt,
    endsAt?: DateTime.Utc,
    key = 'revise',
    purpose = 'Cosmetic presentation wording',
  ) =>
    runAction({
      payload: {
        channels: ['B2C'],
        effectivePeriod: wirePeriod(effectiveAt, endsAt),
        expectedCurrentDefinitionRevisionRef: basis.definitionRevisionRef,
        expectedRevision: basis.revision,
        jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
        marketRef,
        purpose,
        reason: 'Cosmetic revision only',
        supportedLocales: ['cs-CZ'],
      },
      principal,
      registration: reviseMarketDefinitionAction,
      transport: { correlationId: `market-${key}`, idempotencyKey: key },
    }).pipe(Effect.provideContext(context));
  const associate = (basis: { readonly definitionRevisionRef: MarketDefinitionRevisionRef }) =>
    runAction({
      payload: {
        associationId,
        channel: 'B2C',
        effectivePeriod: { startsAt: DateTime.formatIso(startsAt) },
        expectedMarketDefinitionRevisionRef: basis.definitionRevisionRef,
        marketRef,
        provenance: { kind: 'CONFIGURATION_ACTION', reference: 'native-revision' },
        reason: 'Native eligibility basis',
        sellingLegalEntityRef: sellerRef,
        storefrontRef: { appId: storefrontAppId, tenantId: fixture.tenantId },
      },
      principal,
      registration: associateStorefrontAction,
      transport: { correlationId: 'market-associate', idempotencyKey: 'associate' },
    }).pipe(Effect.provideContext(context));
  return {
    after,
    associate,
    before,
    binding,
    context,
    create,
    databaseConfiguration: yield* parseDatabaseConfig({ DATABASE_URL: isolated.connections.runtime.connectionString }),
    marketRef,
    now,
    principal,
    revise,
    revisedAt,
    sellerRef,
    shell,
    snapshot,
  };
});

/** Public, scope-owned test infrastructure. The real Core Actions persist Market truth;
 * generated HTTP reads verify real Shell assertions against the retained native owner runtime.
 * The existing owner runtime redeems assertions against this disposable native owner database.
 */
export const marketRevisionNativeBackend = Effect.gen(function* makeMarketRevisionNativeFixture() {
  const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(server.address);
  const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
  const scenario = yield* makeScenario(true, baseUrl.href);
  const { binding, shell } = scenario;
  if (shell === undefined || binding === undefined) {
    return yield* unavailable();
  }
  const redemptionContext = yield* Layer.build(
    GatewayAssertionRedemptionLive.pipe(
      Layer.provide(GatewayAssertionRedemptionDatabaseLive),
      Layer.provide(Layer.succeed(DatabaseConfig, scenario.databaseConfiguration)),
    ),
  );
  const runtime = yield* commerceMarketCatalogApiRuntimeFromContext.pipe(
    Effect.provideService(ReadRuntime, Context.get(scenario.context, ReadRuntime)),
    Effect.provideService(ActionRuntime, Context.get(scenario.context, ActionRuntime)),
    Effect.provideContext(redemptionContext),
  );
  const configured = defineEffectBff({
    api: runtime.api,
    layer: runtime.layer.pipe(
      Layer.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: shell.compositionSourceUrl,
            ONTOS_GATEWAY_ISSUER: shell.issuer,
            ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
          }),
        ),
      ),
    ),
  });
  const handler = yield* Effect.acquireRelease(
    Effect.promise(resolveEffectBffModuleHandler.bind(undefined, { default: configured }, {})).pipe(
      Effect.flatMap((value) => (value === null ? Effect.fail(unavailable()) : Effect.succeed(value))),
    ),
    (value) => (value.dispose === undefined ? Effect.void : Effect.promise(value.dispose).pipe(Effect.orDie)),
  );
  yield* server.serve(
    Effect.gen(function* receivePublicMarketRequest() {
      const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
      const response = yield* Effect.tryPromise({
        catch: unavailable,
        try: dispatchEffectBffRequest.bind(undefined, handler.handler, request, {
          prefix: commerceMarketCatalogApiContract.apiPrefix,
        }),
      });
      return HttpServerResponse.fromWeb(response);
    }),
  );
  const issue = Effect.fn('MarketRevisionPublicNative.issue')(function* issue(input: {
    readonly audience: typeof marketAppId;
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  }) {
    if (
      input.audience !== marketAppId ||
      input.compositionRevision !== scenario.snapshot.composition.revision ||
      input.legalEntityId !== scenario.principal.legalEntityId
    ) {
      return yield* new MarketRevisionNativeIssueUnavailable({ stage: 'INPUT_SCOPE_INVALID' });
    }
    const admitted = yield* issueApiKeyGatewayContext(input, {
      apiKey: binding.secret,
      baseUrl: shell.baseUrl,
      requestCorrelation: input.requestCorrelation,
    }).pipe(Effect.mapError(() => new MarketRevisionNativeIssueUnavailable({ stage: 'SHELL_GATEWAY_UNAVAILABLE' })));
    const expectedIngress = `/shell-super-app-api/module-api/${encodeURIComponent(marketAppId)}/${encodeURIComponent(ultramodernApiMarker.buildMarker)}${commerceMarketCatalogApiContract.apiPrefix}`;
    const shellOrigin = new URL(shell.baseUrl);
    const admittedBaseUrl = yield* Effect.try({
      catch: () => new MarketRevisionNativeIssueUnavailable({ stage: 'ADMISSION_MISMATCH' }),
      try: () => new URL(admitted.apiBaseUrl, shellOrigin),
    });
    if (
      admitted.compositionRevision !== scenario.snapshot.composition.revision ||
      admitted.apiBaseUrl !== expectedIngress ||
      admittedBaseUrl.origin !== shellOrigin.origin ||
      admittedBaseUrl.pathname !== expectedIngress ||
      admittedBaseUrl.search !== '' ||
      admittedBaseUrl.hash !== '' ||
      admittedBaseUrl.username !== '' ||
      admittedBaseUrl.password !== ''
    ) {
      return yield* new MarketRevisionNativeIssueUnavailable({ stage: 'ADMISSION_MISMATCH' });
    }
    return { baseUrl: admittedBaseUrl, credential: Redacted.make(`Bearer ${admitted.token}`) };
  });
  return Object.freeze({
    after: scenario.after,
    baseUrl,
    before: scenario.before,
    compositionRevision: scenario.snapshot.composition.revision,
    createR1: Effect.fn('MarketRevisionPublicNative.createR1')(function* createR1() {
      const result = yield* scenario.create();
      yield* scenario.associate(result);
      return result;
    }),
    issue,
    legalEntityId: scenario.sellerRef.resourceId,
    marketRef: scenario.marketRef,
    now: scenario.now,
    principal: scenario.principal,
    revisedAt: scenario.revisedAt,
    reviseR2: scenario.revise,
    sellerRef: scenario.sellerRef,
    snapshot: scenario.snapshot,
    tenantId: scenario.principal.tenantId,
  });
});
