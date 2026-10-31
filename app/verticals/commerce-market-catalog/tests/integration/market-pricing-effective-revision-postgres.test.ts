import {
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  parseDatabaseConfig,
  OwnerAuthorizationOverlay,
  ReadRuntime,
  runAction,
  findPostgresFailure,
  bindSelfApiKeyAction,
  ActiveApplicationCompositionSnapshotSchema,
} from '@app/core-runtime';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import {
  makeModuleContractFixture,
  makeApplicationCompositionSnapshotFixture,
} from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import {
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Redacted,
  Result,
  Schema,
  Stream,
} from 'effect';
import { FetchHttpClient } from 'effect/http';
import {
  makeApiKeyGatewayNativeComposition,
  makeApiKeyGatewayNativeFixture,
  sealApiKeyGatewayNativeComposition,
} from '@app/shell-super-app/testing/api-key-gateway-native';
import { makeCurrentStorefrontNativeReceiver } from '@app/storefront-registry/testing/current-storefront-native';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { assert, expect, it } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { StorefrontApplicationValidationUnavailable } from '../../src/integrations/current-storefront-application.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

import type { MarketDefinitionRevisionRef } from '../../shared/resources/market-definition-revision.ts';
import type { PricingMarketSourceReceipt } from '../../shared/apis/pricing-current-market-evidence.ts';
import { PricingMarketSourceReceiptSchema } from '../../shared/apis/pricing-current-market-evidence.ts';
import { EligibleMarketTuplesRequestSchema } from '../../shared/apis/eligible-market-tuples.ts';
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
  marketRetirementAdmissions,
  commerceMarketCatalogRelations,
  marketCatalogCompletenessGenerations,
  marketDefinitionRevisions,
  marketLifecyclePeriods,
  markets,
} from '../../src/database/schema.ts';
import { marketResolutionPersistenceForScope } from '../../src/persistence/market-resolution-persistence.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
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

const makeScenario = Effect.fn('MarketRevisionNative.makeScenario')(function* makeScenario(withRegistry: boolean) {
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
    const process = yield* ChildProcess.make(
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
        cwd: new URL('../../../../', import.meta.url).pathname,
        env: {
          DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
          DATABASE_URL: isolated.connections.runtime.connectionString,
          ONTOS_MARKET_REVISION_MIGRATIONS: new URL('../../drizzle/', import.meta.url).pathname,
          ONTOS_MARKET_REVISION_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
        },
        extendEnv: true,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    );
    // Migration diagnostics can contain URLs; drain both pipes without disclosing credentials.
    const [status] = yield* Effect.all(
      [process.exitCode, Stream.runDrain(process.stdout), Stream.runDrain(process.stderr)],
      { concurrency: 3 },
    );
    expect(Number(status)).toBe(0);
  });
  yield* migrateOwner();
  const databaseServices = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(databaseServices));
  const admin = yield* makeWithDefaults({ relations: commerceMarketCatalogRelations }).pipe(
    Effect.provide(databaseServices),
  );
  const runtimeRole = sql.identifier(isolated.connections.runtime.user);
  // Fixture-only business table access supports scoped inspection and append-only guard controls.
  // Pre-authentication replay storage retains exactly its production SELECT/INSERT/DELETE privileges.
  yield* admin.execute(sql`grant usage on schema commerce_market_catalog to ${runtimeRole}`, 'objects');
  yield* Effect.forEach(
    COMMERCE_MARKET_CATALOG_TABLES.filter(
      (table) => table !== gatewayAssertionRedemptions && table !== marketRetirementAdmissions,
    ),
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
  expect(replayPrivileges).toEqual({ canDelete: true, canInsert: true, canSelect: true, canUpdate: false });
  const registry = withRegistry ? yield* makeCurrentStorefrontNativeReceiver() : undefined;
  const baseSnapshot =
    registry === undefined
      ? yield* makeApplicationCompositionSnapshotFixture(['commerce-market-catalog'], 'market-effective-revision')
      : yield* makeApiKeyGatewayNativeComposition(
          [
            makeModuleContractFixture({
              appId: 'commerce-market-catalog',
              buildMarker: ultramodernApiMarker.buildMarker,
              moduleId: moduleKey,
            }),
            makeModuleContractFixture({
              appId: registry.deployment.appId,
              buildMarker: registry.deployment.buildMarker,
              moduleId: 'commerce.storefront-registry',
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
            modules: baseSnapshot.composition.modules.map((module) =>
              module.deployment.appId === registry.deployment.appId
                ? {
                    ...module,
                    backend: { baseUrl: registry.baseUrl, transport: 'node-http' as const },
                  }
                : module,
            ),
          }),
        };
  yield* isolated.publishInitialComposition(snapshot);
  const shell =
    registry === undefined
      ? undefined
      : yield* makeApiKeyGatewayNativeFixture({
          ownedDatabase: isolated,
          relaySource: { sourceAppId: 'commerce-market-catalog' },
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
    actionExecutor: 'manager-only' as const,
    actionKeys: [
      ...actionKeys,
      bindSelfApiKeyAction.descriptor.actionKey,
      'commerce.storefront-registry.register-storefront-application',
    ],
    adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
    allowedAudiences: ['commerce-market-catalog', 'storefront-registry'],
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    compositionRevision: snapshot.composition.revision,
    moduleKeys: [moduleKey, 'commerce.storefront-registry'],
    runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
  };
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture(
      shell === undefined
        ? baseConfiguration
        : {
            ...baseConfiguration,
            managerProviderSubjectId: shell.providerUserId,
            readerActionKeys: [bindSelfApiKeyAction.descriptor.actionKey],
            readerProviderSubjectId: shell.relaySourceProviderUserId,
          },
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
  const ownerAuthorization = Layer.succeed(OwnerAuthorizationOverlay, {
    authorize: (_transaction, input) => {
      const originalActor = input.scope.principalId === fixture.manager.principalId;
      const sourceKeyBinding =
        input.owningModuleKey === 'core.identity' &&
        input.operationKey === bindSelfApiKeyAction.descriptor.actionKey &&
        (originalActor || input.scope.principalId === fixture.reader.principalId);
      const ownerOperation =
        originalActor &&
        (input.scope.legalEntityId === fixture.legalEntityId || input.scope.legalEntityId === undefined) &&
        ((input.owningModuleKey === moduleKey &&
          input.scope.legalEntityId === fixture.legalEntityId &&
          (actionKeys.includes(input.operationKey) ||
            [currentMarketCatalogRead, pricingCurrentMarketEvidenceRead, marketHistoryRead].some(
              (registration) => registration.descriptor.readKey === input.operationKey,
            ))) ||
          (registry !== undefined &&
            input.owningModuleKey === 'commerce.storefront-registry' &&
            [
              'commerce.storefront-registry.register-storefront-application',
              'commerce.storefront-registry.api.current-storefront-application',
            ].includes(input.operationKey)));
      return Effect.succeed(
        input.scope.tenantId === fixture.tenantId && (sourceKeyBinding || ownerOperation)
          ? ('allowed' as const)
          : ('unavailable' as const),
      );
    },
  });
  if (registry !== undefined) {
    yield* fixture.grantResourceAccess(
      {
        moduleId: 'commerce.storefront-registry',
        resourceId: 'native-storefront',
        resourceType: 'commerce.storefront-registry.storefront-application',
      },
      fixture.manager.principalId,
      'writer',
    );
  }
  // Build scoped Core clients once; retained Registry callbacks use this same live context.
  const baseContext = yield* Layer.build(fixture.layer.pipe(Layer.provide(ownerAuthorization)));
  const binding =
    shell === undefined ? undefined : yield* shell.issueAndBind(principal).pipe(Effect.provideContext(baseContext));
  const associationRuntime = yield* Effect.gen(function* verifiedAssociationContext() {
    if (shell === undefined || binding === undefined) {
      return {
        context: baseContext,
        verify: (_authorization: Redacted.Redacted) =>
          Effect.fail(
            new StorefrontApplicationValidationUnavailable({
              code: 'storefront_application_validation_unavailable',
              reason: 'This owner SQL scenario has no receiving gateway',
            }),
          ),
      };
    }
    const relayBinding = yield* shell.issueRelaySourceAndBind(fixture.reader).pipe(Effect.provideContext(baseContext));
    const provider = ConfigProvider.orElse(
      ConfigProvider.fromEnvRecord({
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: shell.compositionSourceUrl,
        ONTOS_GATEWAY_ISSUER: shell.issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
        ONTOS_GATEWAY_RELAY_API_KEY: Redacted.value(relayBinding.secret),
        ONTOS_SHELL_GATEWAY_BASE_URL: shell.baseUrl,
      }),
      yield* ConfigProvider.ConfigProvider,
    );
    const database = Layer.succeed(
      DatabaseConfig,
      yield* parseDatabaseConfig({ DATABASE_URL: isolated.connections.runtime.connectionString }),
    );
    const redemptionLayer = GatewayAssertionRedemptionLive.pipe(
      Layer.provide(GatewayAssertionRedemptionDatabaseLive),
      Layer.provide(database),
    );
    const compositionSource = ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer));
    const receiving = yield* Layer.build(
      Layer.mergeAll(ActionPrincipalVerifierLive, redemptionLayer).pipe(
        Layer.provide(compositionSource),
        Layer.provide(ConfigProvider.layer(provider)),
      ),
    );
    const context = Context.add(Context.merge(baseContext, receiving), ConfigProvider.ConfigProvider, provider);
    return {
      context,
      verify: (authorization: Redacted.Redacted) =>
        GatewayAssertionRedemptionService.pipe(
          Effect.flatMap((redemption) =>
            bindGatewayPrincipalVerifier('commerce-market-catalog', ultramodernApiMarker).verifyAndRedeem(
              authorization,
              { redemption },
            ),
          ),
          Effect.provideContext(context),
        ),
    };
  });
  const { context } = associationRuntime;
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
            storefrontAppId: 'native-storefront',
          })
          .pipe(Effect.provideContext(context));
  // Derive the native timeline from the same PostgreSQL clock as the owner observation.
  // A virtual process clock cannot advance this authority, and host clocks may be skewed.
  const databaseNow = Effect.fn('MarketRevisionNative.databaseNow')(function* databaseNow() {
    const [row] = yield* admin.execute<typeof databaseObservationSchema.Encoded>(
      sql`select to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "observedAt"`,
      'objects',
    );
    assert(row !== undefined);
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
        storefrontAppId: 'native-storefront',
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
  const current = (at: DateTime.Utc) =>
    Effect.gen(function* currentMarket() {
      const runtime = yield* ReadRuntime;
      return yield* runtime.runRead({
        input: { at: DateTime.formatIso(at) },
        principal,
        registration: currentMarketCatalogRead,
        transport: { correlationId: 'market-current' },
      });
    }).pipe(Effect.provideContext(context));
  const pricing = (
    at: DateTime.Utc,
    channel: 'B2C' | 'B2B' = 'B2C',
    second = false,
    retainedReceipt?: PricingMarketSourceReceipt,
  ) =>
    Effect.gen(function* pricingMarket() {
      const runtime = yield* ReadRuntime;
      const base = {
        commercialScope: {
          channel,
          marketRef: second ? secondMarketRef : marketRef,
          sellingLegalEntityRef: sellerRef,
        },
        effectiveAt: DateTime.formatIso(at),
        requestedAt: DateTime.formatIso(now),
      };
      const input =
        retainedReceipt === undefined
          ? base
          : {
              ...base,
              retainedReceipt: yield* Schema.encodeEffect(PricingMarketSourceReceiptSchema)(retainedReceipt),
            };
      return yield* runtime.runRead({
        input,
        principal,
        registration: pricingCurrentMarketEvidenceRead,
        transport: { correlationId: 'pricing-market' },
      });
    }).pipe(Effect.provideContext(context));
  const history = () =>
    Effect.gen(function* marketHistory() {
      const runtime = yield* ReadRuntime;
      return yield* runtime.runRead({
        input: { marketRef },
        principal,
        registration: marketHistoryRead,
        transport: { correlationId: 'market-history' },
      });
    }).pipe(Effect.provideContext(context));
  const observe = () =>
    fixture
      .prepareOwner(
        (transaction) =>
          Effect.all(
            {
              definitions: transaction
                .select()
                .from(marketDefinitionRevisions)
                .orderBy(marketDefinitionRevisions.revisionNumber),
              generations: transaction.select().from(marketCatalogCompletenessGenerations),
              lifecycle: transaction.select().from(marketLifecyclePeriods),
              markets: transaction.select().from(markets),
            },
            { concurrency: 1 },
          ),
        'required',
      )
      .pipe(Effect.provideContext(context));
  const associate = (basis: { readonly definitionRevisionRef: MarketDefinitionRevisionRef }) =>
    Effect.gen(function* verifiedNativeAssociation() {
      if (shell === undefined || binding === undefined) {
        return yield* new StorefrontApplicationValidationUnavailable({
          code: 'storefront_application_validation_unavailable',
          reason: 'This owner SQL scenario has no Storefront receiver',
        });
      }
      const admitted = yield* issueApiKeyGatewayContext(
        {
          audience: 'commerce-market-catalog',
          compositionRevision: snapshot.composition.revision,
          legalEntityId: fixture.legalEntityId,
        },
        { apiKey: binding.secret, baseUrl: shell.baseUrl, requestCorrelation: 'market-associate' },
      );
      const verifiedPrincipal = yield* associationRuntime.verify(Redacted.make(`Bearer ${admitted.token}`));
      expect(verifiedPrincipal.principalId).toBe(principal.principalId);
      return yield* runAction({
        payload: {
          associationId,
          channel: 'B2C',
          effectivePeriod: { startsAt: DateTime.formatIso(startsAt) },
          expectedMarketDefinitionRevisionRef: basis.definitionRevisionRef,
          marketRef,
          provenance: { kind: 'CONFIGURATION_ACTION', reference: 'native-revision' },
          reason: 'Native eligibility basis',
          sellingLegalEntityRef: sellerRef,
          storefrontRef: { appId: 'native-storefront', tenantId: fixture.tenantId },
        },
        principal: verifiedPrincipal,
        registration: associateStorefrontAction,
        transport: { correlationId: 'market-associate', idempotencyKey: 'associate' },
      });
    }).pipe(Effect.provideContext(context));
  // Native eligibility routine under genuine owner scope; no forged trusted Storefront context.
  // Full Storefront gateway admission is a separate boundary from this owner SQL selection proof.
  const eligibility = (at: DateTime.Utc) =>
    fixture
      .prepareOwner(
        (transaction, scope) =>
          Effect.gen(function* ownerEligibility() {
            const input = yield* Schema.decodeUnknownEffect(EligibleMarketTuplesRequestSchema)({
              channel: 'B2C',
              effectiveAt: DateTime.formatIso(at),
              sellingLegalEntityRestriction: sellerRef,
              storefrontRef: { appId: 'native-storefront', tenantId: fixture.tenantId },
            });
            const persistence = yield* marketResolutionPersistenceForScope(
              transaction,
              scope,
              snapshot.composition.revision,
            );
            return yield* persistence.load(input);
          }),
        'required',
      )
      .pipe(Effect.provideContext(context));
  const suspend = (basis: { readonly definitionRevisionRef: MarketDefinitionRevisionRef; readonly revision: number }) =>
    runAction({
      payload: {
        effectiveAt: DateTime.formatIso(after),
        expectedCurrentDefinitionRevisionRef: basis.definitionRevisionRef,
        expectedRevision: basis.revision,
        marketRef,
        reason: 'Suspend exact Market',
      },
      principal,
      registration: suspendMarketAction,
      transport: { correlationId: 'market-suspend', idempotencyKey: 'suspend' },
    }).pipe(Effect.provideContext(context));
  const denyHistoryMutation = (remove: boolean) =>
    fixture
      .prepareOwner(
        (transaction) =>
          remove
            ? transaction.delete(marketDefinitionRevisions).where(eq(marketDefinitionRevisions.marketId, marketId))
            : transaction
                .update(marketDefinitionRevisions)
                .set({ purpose: 'Forbidden history rewrite' })
                .where(eq(marketDefinitionRevisions.marketId, marketId)),
        'required',
      )
      .pipe(Effect.provideContext(context), Effect.flip);
  // Deliberately damaged facts are confined to this fixture-owned disposable database.
  // Positive commercial truth always comes from the public writers above.
  const addCompetingLifecycle = Effect.fn('MarketRevisionNative.addCompetingLifecycle')(
    function* addCompetingLifecycle() {
      yield* admin.insert(marketLifecyclePeriods).values({
        actingPrincipalId: fixture.manager.principalId,
        actionInvocationId: yield* crypto.randomUUIDv4(),
        effectiveFrom: DateTime.toDateUtc(startsAt),
        lifecycle: 'SUSPENDED',
        marketId,
        reason: 'Adversarial isolated native lifecycle overlap',
        revisionNumber: 2,
        sellingLegalEntityId: fixture.legalEntityId,
        tenantId: fixture.tenantId,
      });
    },
  );
  const removeCompleteness = () =>
    admin
      .delete(marketCatalogCompletenessGenerations)
      .where(eq(marketCatalogCompletenessGenerations.tenantId, fixture.tenantId));
  const journal = () =>
    admin.execute<{ readonly hash: string; readonly name: string }>(
      sql`select hash, name from drizzle.__drizzle_migrations_commerce_market_catalog order by name`,
      'objects',
    );
  return {
    addCompetingLifecycle,
    after,
    associate,
    before,
    context,
    coreEvidenceExecutor,
    create,
    current,
    databaseNow,
    denyHistoryMutation,
    eligibility,
    fixture,
    history,
    journal,
    marketRef,
    migrateOwner,
    now,
    observe,
    pricing,
    principal,
    removeCompleteness,
    revise,
    revisedAt,
    secondMarketRef,
    sellerRef,
    startsAt,
    suspend,
  };
});

it.live('isolates the public cosmetic Market revision predicate without Storefront association', () =>
  Effect.scoped(
    Effect.gen(function* isolatedRevisionPredicate() {
      const scenario = yield* makeScenario(false);
      const r1 = yield* scenario.create();
      const initial = yield* scenario.pricing(scenario.after);
      expect(initial.outcome).toBe('PRICING_MARKET_SOURCE_PRESENT');
      const r2 = yield* scenario.revise(r1);
      expect(r2.revision).toBe(2);
      expect((yield* scenario.history()).definitions).toHaveLength(2);
      expect((yield* scenario.current(scenario.revisedAt)).markets[0]?.definitionRevisionRef).toEqual(
        r2.definitionRevisionRef,
      );
      const selected = yield* scenario.pricing(scenario.revisedAt);
      expect(selected.outcome).toBe('PRICING_MARKET_SOURCE_PRESENT');
      assert(selected.outcome === 'PRICING_MARKET_SOURCE_PRESENT');
      expect(selected.market.definitionRevisionRef).toEqual(r2.definitionRevisionRef);
      expect((yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor)).outbox).toHaveLength(2);
    }),
  ).pipe(Effect.provide(nativeServices)),
);

it.live('selects the effective immutable revision from supported cosmetic public R1 then R2 in all owner reads', () =>
  Effect.scoped(
    Effect.gen(function* effectiveRevision() {
      const scenario = yield* makeScenario(true);
      const r1 = yield* scenario.create();
      yield* scenario.associate(r1);
      const original = yield* scenario.pricing(scenario.after);
      assert(original.outcome === 'PRICING_MARKET_SOURCE_PRESENT');
      const r2 = yield* scenario.revise(r1);
      expect(r2.revision).toBe(2);
      expect((yield* scenario.history()).definitions).toHaveLength(2);
      expect((yield* scenario.current(scenario.revisedAt)).markets[0]?.definitionRevisionRef).toEqual(
        r2.definitionRevisionRef,
      );
      const before = yield* scenario.pricing(scenario.before);
      const at = yield* scenario.pricing(scenario.revisedAt);
      const after = yield* scenario.pricing(scenario.after);
      expect(before.outcome).toBe('PRICING_MARKET_SOURCE_PRESENT');
      assert(before.outcome === 'PRICING_MARKET_SOURCE_PRESENT');
      expect(before.market.definitionRevisionRef).toEqual(r1.definitionRevisionRef);
      expect(at.outcome).toBe('PRICING_MARKET_SOURCE_PRESENT');
      expect(after.outcome).toBe('PRICING_MARKET_SOURCE_PRESENT');
      assert(at.outcome === 'PRICING_MARKET_SOURCE_PRESENT' && after.outcome === 'PRICING_MARKET_SOURCE_PRESENT');
      expect(at.market.definitionRevisionRef).toEqual(r2.definitionRevisionRef);
      expect(after.market.definitionRevisionRef).toEqual(r2.definitionRevisionRef);
      expect((yield* scenario.current(scenario.before)).markets[0]?.definitionRevisionRef).toEqual(
        r1.definitionRevisionRef,
      );
      expect((yield* scenario.current(scenario.revisedAt)).markets[0]?.definitionRevisionRef).toEqual(
        r2.definitionRevisionRef,
      );
      for (const [time, revision] of [
        [scenario.before, r1],
        [scenario.revisedAt, r2],
        [scenario.after, r2],
      ] as const) {
        expect((yield* scenario.eligibility(time)).facts[0]?.tuple.marketDefinitionRevisionRef).toEqual(
          revision.definitionRevisionRef,
        );
        expect((yield* scenario.current(time)).markets[0]?.definitionRevisionRef).toEqual(
          revision.definitionRevisionRef,
        );
      }
      expect(DateTime.toEpochMillis(after.receipt.authority.observedAt)).toBeGreaterThanOrEqual(
        DateTime.toEpochMillis(scenario.after),
      );
      expect(after.receipt.currentFacts[0]?.factRevisionRef).toContain(r2.definitionRevisionRef.resourceId);
      expect((yield* scenario.pricing(scenario.after, 'B2C', false, original.receipt)).outcome).toBe(
        'PRICING_MARKET_SOURCE_CHANGED',
      );
      const retained = yield* scenario.history();
      expect(retained.definitions.map((definition) => definition.revision)).toEqual([1, 2]);
      expect(retained.definitions[0]?.effectivePeriod.endsAt).toBeUndefined();
      expect(retained.definitions[1]?.previousDefinitionRevisionRef).toEqual(r1.definitionRevisionRef);
      expect((yield* scenario.observe()).definitions).toHaveLength(2);
      expect(
        (yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor)).outbox.filter(
          (message) => message.producerModuleKey === moduleKey,
        ),
      ).toHaveLength(3);
    }),
  ).pipe(Effect.provide(nativeServices)),
);

it.live('does not resurrect an open predecessor after the latest started revision expires', () =>
  Effect.scoped(
    Effect.gen(function* expiredSuccessor() {
      const scenario = yield* makeScenario(true);
      const r1 = yield* scenario.create();
      yield* scenario.associate(r1);
      const end = shift(scenario.now, -600_000);
      const r2 = yield* scenario.revise(r1, scenario.revisedAt, end);
      const before = yield* scenario.pricing(shift(end, -1));
      assert(before.outcome === 'PRICING_MARKET_SOURCE_PRESENT');
      expect(before.market.definitionRevisionRef).toEqual(r2.definitionRevisionRef);
      expect((yield* scenario.pricing(end)).outcome).toBe('PRICING_MARKET_SOURCE_MISSING');
      const ordinary = yield* scenario.current(end).pipe(Effect.flip);
      expect(Predicate.isTagged(ordinary, 'ReadHandlerUnavailable')).toBe(true);
      expect((yield* scenario.eligibility(end)).facts).toEqual([]);
      expect((yield* scenario.history()).definitions).toHaveLength(2);
    }),
  ).pipe(Effect.provide(nativeServices)),
);

it.live('retains a future predecessor until the real successor boundary and preserves generation proof', () =>
  Effect.scoped(
    Effect.gen(function* actualFutureBoundary() {
      const scenario = yield* makeScenario(false);
      const r1 = yield* scenario.create();
      const future = shift(yield* scenario.databaseNow(), 1500);
      const r2 = yield* scenario.revise(r1, future);
      const observation = yield* scenario.databaseNow();
      assert(DateTime.toEpochMillis(observation) < DateTime.toEpochMillis(future));
      const before = yield* scenario.pricing(observation);
      assert(before.outcome === 'PRICING_MARKET_SOURCE_PRESENT');
      expect(before.market.definitionRevisionRef).toEqual(r1.definitionRevisionRef);
      expect(before.receipt.authority.nextApplicabilityBoundary).toEqual(future);
      const millis = DateTime.toEpochMillis(future) - DateTime.toEpochMillis(yield* scenario.databaseNow()) + 10;
      yield* Effect.sleep(Duration.millis(Math.max(0, millis)));
      const after = yield* scenario.pricing(future);
      assert(after.outcome === 'PRICING_MARKET_SOURCE_PRESENT');
      expect(after.market.definitionRevisionRef).toEqual(r2.definitionRevisionRef);
      expect((yield* scenario.current(future)).markets[0]?.definitionRevisionRef).toEqual(r2.definitionRevisionRef);
    }),
  ).pipe(Effect.provide(nativeServices)),
);

it.live('preserves no-op, stale CAS, concurrent revision and immutable history boundaries', () =>
  Effect.scoped(
    Effect.gen(function* administrativeBoundaries() {
      const scenario = yield* makeScenario(false);
      const r1 = yield* scenario.create();
      const r2 = yield* scenario.revise(r1);
      const before = yield* scenario.observe();
      const { outbox } = yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor);
      yield* scenario.revise(r2, scenario.revisedAt, undefined, 'no-op');
      expect(yield* scenario.observe()).toEqual(before);
      expect((yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor)).outbox).toEqual(outbox);
      const stale = yield* scenario.revise(r1, scenario.revisedAt, undefined, 'stale').pipe(Effect.flip);
      expect(Predicate.isTagged(stale, 'MarketCommandRejected')).toBe(true);
      expect(stale.code).toBe('revision_conflict');
      const results = yield* Effect.all(
        [
          scenario.revise(r2, scenario.revisedAt, undefined, 'race-a', 'Cosmetic A').pipe(Effect.result),
          scenario.revise(r2, scenario.revisedAt, undefined, 'race-b', 'Cosmetic B').pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      const loser = results.find(Result.isFailure);
      assert(loser !== undefined);
      assert(Predicate.isTagged(loser.failure, 'MarketCommandRejected'));
      expect(loser.failure.code).toBe('revision_conflict');
      const afterRace = yield* scenario.observe();
      expect(afterRace.definitions).toHaveLength(3);
      expect(afterRace.generations[0]?.generation).toBe((before.generations[0]?.generation ?? 0) + 1);
      expect((yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor)).outbox).toHaveLength(outbox.length + 1);
      for (const remove of [false, true]) {
        const denied = yield* scenario.denyHistoryMutation(remove);
        expect(Option.isSome(findPostgresFailure(denied, ({ code }) => code === '55000'))).toBe(true);
      }
      expect((yield* scenario.history()).definitions).toHaveLength(3);
    }),
  ).pipe(Effect.provide(nativeServices)),
);

it.live('keeps exact identities, channels, completeness and unprovable time fail closed', () =>
  Effect.scoped(
    Effect.gen(function* sourceBoundaries() {
      const scenario = yield* makeScenario(false);
      expect((yield* scenario.pricing(scenario.now)).outcome).toBe('PRICING_MARKET_SOURCE_MISSING');
      const r1 = yield* scenario.create();
      const second = yield* scenario.create(undefined, true);
      const r2 = yield* scenario.revise(r1);
      const selected = yield* scenario.pricing(scenario.after);
      const other = yield* scenario.pricing(scenario.after, 'B2C', true);
      assert(selected.outcome === 'PRICING_MARKET_SOURCE_PRESENT' && other.outcome === 'PRICING_MARKET_SOURCE_PRESENT');
      expect(selected.market.marketRef).toEqual(r2.marketRef);
      expect(other.market.marketRef).toEqual(second.marketRef);
      expect((yield* scenario.current(scenario.after)).markets).toHaveLength(2);
      expect((yield* scenario.pricing(scenario.after, 'B2B')).outcome).toBe('PRICING_MARKET_SOURCE_ABSENT');
      expect((yield* scenario.pricing(shift(scenario.now, 86_400_000))).outcome).toBe(
        'PRICING_MARKET_SOURCE_UNVERIFIABLE',
      );
      const before = yield* scenario.observe();
      const { outbox } = yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor);
      yield* Effect.gen(function* rejectUntrustedScopes() {
        const runtime = yield* ReadRuntime;
        const request = {
          commercialScope: { channel: 'B2C', marketRef: scenario.marketRef, sellingLegalEntityRef: scenario.sellerRef },
          effectiveAt: DateTime.formatIso(scenario.after),
          requestedAt: DateTime.formatIso(scenario.now),
        };
        const missingScope = yield* runtime
          .runRead({
            input: request,
            principal: { ...scenario.fixture.denied, legalEntityId: scenario.fixture.legalEntityId },
            registration: pricingCurrentMarketEvidenceRead,
            transport: { correlationId: 'missing-scope' },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(missingScope, 'OperationContextDenied')).toBe(true);
        const missingPermission = yield* runtime
          .runRead({
            input: request,
            principal: scenario.fixture.legalEntityOnly,
            registration: pricingCurrentMarketEvidenceRead,
            transport: { correlationId: 'missing-permission' },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(missingPermission, 'ReadPermissionDenied')).toBe(true);
        const foreignTenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const wrongTenant = yield* runtime
          .runRead({
            input: {
              ...request,
              commercialScope: {
                ...request.commercialScope,
                marketRef: { ...scenario.marketRef, tenantId: foreignTenant },
                sellingLegalEntityRef: { ...scenario.sellerRef, tenantId: foreignTenant },
              },
            },
            principal: scenario.principal,
            registration: pricingCurrentMarketEvidenceRead,
            transport: { correlationId: 'foreign-tenant' },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(wrongTenant, 'ReadPermissionDenied')).toBe(true);
        const wrongSeller = yield* runtime
          .runRead({
            input: {
              ...request,
              commercialScope: {
                ...request.commercialScope,
                sellingLegalEntityRef: { ...scenario.sellerRef, resourceId: foreignTenant },
              },
            },
            principal: scenario.principal,
            registration: pricingCurrentMarketEvidenceRead,
            transport: { correlationId: 'foreign-seller' },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(wrongSeller, 'ReadPermissionDenied')).toBe(true);
      }).pipe(Effect.provideContext(scenario.context));
      expect((yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor)).outbox).toEqual(outbox);
      expect(yield* scenario.observe()).toEqual(before);
    }),
  ).pipe(Effect.provide(nativeServices)),
);

it.live('retains lifecycle conflict and nonoverlap semantics and reapplies the journal idempotently', () =>
  Effect.scoped(
    Effect.gen(function* retainedSafeguards() {
      const scenario = yield* makeScenario(false);
      // Create leaves the independent ACTIVE lifecycle open. A definition revision cannot extend it.
      const r1 = yield* scenario.create();
      const r2 = yield* scenario.revise(r1, scenario.before, scenario.revisedAt, 'finite-predecessor');
      const r3 = yield* scenario.revise(r2, scenario.revisedAt, undefined, 'open-successor');
      const beforeBoundary = yield* scenario.pricing(scenario.before);
      const at = yield* scenario.pricing(scenario.revisedAt);
      expect(beforeBoundary.outcome).toBe('PRICING_MARKET_SOURCE_PRESENT');
      expect(at.outcome).toBe('PRICING_MARKET_SOURCE_PRESENT');
      assert(
        beforeBoundary.outcome === 'PRICING_MARKET_SOURCE_PRESENT' && at.outcome === 'PRICING_MARKET_SOURCE_PRESENT',
      );
      expect(beforeBoundary.market.definitionRevisionRef).toEqual(r2.definitionRevisionRef);
      expect(at.market.definitionRevisionRef).toEqual(r3.definitionRevisionRef);
      const retained = yield* scenario.history();
      expect(retained.definitions.map((definition) => definition.revision)).toEqual([1, 2, 3]);
      expect(retained.definitions[1]?.effectivePeriod.endsAt).toEqual(scenario.revisedAt);
      expect(retained.definitions[2]?.previousDefinitionRevisionRef).toEqual(r2.definitionRevisionRef);
      yield* scenario.suspend(r3);
      // A single valid SUSPENDED lifecycle is ABSENT; CONFLICT requires competing Current lifecycle facts.
      const suspended = yield* scenario.pricing(scenario.after);
      expect(suspended.outcome).toBe('PRICING_MARKET_SOURCE_ABSENT');
      assert(suspended.outcome === 'PRICING_MARKET_SOURCE_ABSENT');
      expect(suspended.receipt.state).toBe('ABSENT');
      expect(suspended.receipt.currentFacts).toEqual([]);
      expect((yield* scenario.history()).definitions).toEqual(retained.definitions);
      expect((yield* scenario.current(scenario.after)).markets[0]?.lifecycle).toBe('SUSPENDED');
      const before = yield* scenario.journal();
      yield* scenario.migrateOwner();
      expect(yield* scenario.journal()).toEqual(before);
    }),
  ).pipe(Effect.provide(nativeServices)),
);

it.live('keeps damaged native lifecycle and completeness proofs distinct from retained definition overlap', () =>
  Effect.scoped(
    Effect.gen(function* damagedNativeAuthority() {
      const conflicted = yield* makeScenario(false);
      const original = yield* conflicted.create();
      const revised = yield* conflicted.revise(original);
      yield* conflicted.addCompetingLifecycle();
      const conflict = yield* conflicted.pricing(conflicted.after);
      expect(conflict.outcome).toBe('PRICING_MARKET_SOURCE_CONFLICT');
      assert(conflict.outcome === 'PRICING_MARKET_SOURCE_CONFLICT');
      expect(conflict.reason).toBe('Multiple Current Market lifecycle facts match the exact scope');
      expect(conflict).not.toHaveProperty('receipt');
      expect((yield* conflicted.history()).definitions.map((definition) => definition.definitionRevisionRef)).toEqual([
        original.definitionRevisionRef,
        revised.definitionRevisionRef,
      ]);
      const incomplete = yield* makeScenario(false);
      yield* incomplete.create();
      expect((yield* incomplete.pricing(incomplete.after)).outcome).toBe('PRICING_MARKET_SOURCE_PRESENT');
      yield* incomplete.removeCompleteness();
      const missing = yield* incomplete.pricing(incomplete.after);
      expect(missing.outcome).toBe('PRICING_MARKET_SOURCE_MISSING');
      assert(missing.outcome === 'PRICING_MARKET_SOURCE_MISSING');
      expect(missing.reason).toBe('Market Catalog completeness generation is unavailable');
      expect(missing).not.toHaveProperty('receipt');
    }),
  ).pipe(Effect.provide(nativeServices)),
);
