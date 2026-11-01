import type { MarketRevisionNativeCustomerContextState } from '../support/market-revision-native-protocol.ts';
import {
  DatabaseConfig,
  parseDatabaseConfig,
  OwnerAuthorizationOverlay,
  ReadRuntime,
  ActionRuntime,
  bindSelfApiKeyAction,
  ActiveApplicationCompositionSnapshotSchema,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  makeActionRuntimeLive,
  OperationalScopeResolver,
  ReadRuntimeLive,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices, NodeHttpServer } from '@effect/platform-node';
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
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import {
  makeApiKeyGatewayNativeFixture,
  sealApiKeyGatewayNativeComposition,
} from '@app/shell-super-app/testing/api-key-gateway-native';
import { deriveActiveApplicationCompositionSnapshot } from '../../../../scripts/active-application-composition.mts';
import { makeCurrentStorefrontNativeReceiver } from '@app/storefront-registry/testing/current-storefront-native';
import { makeMarketRetirementNativeReceiver } from '@app/commerce-customer-context/testing/market-retirement-native';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import type { MarketDefinitionRevisionRef } from '../../shared/resources/market-definition-revision.ts';
import { createMarketAction } from '../../src/actions/create-market.action.ts';
import { reviseMarketDefinitionAction } from '../../src/actions/revise-market-definition.action.ts';
import { associateStorefrontAction } from '../../src/actions/associate-storefront.action.ts';
import { suspendMarketAction } from '../../src/actions/suspend-market.action.ts';
import { activateMarketAction } from '../../src/actions/activate-market.action.ts';
import { reviseStorefrontAssociationAction } from '../../src/actions/revise-storefront-association.action.ts';
import { removeStorefrontAssociationAction } from '../../src/actions/remove-storefront-association.action.ts';
import { retireMarketAction } from '../../src/actions/retire-market.action.ts';
import { manageMarketRetirementAdmissionAction } from '../../src/actions/manage-market-retirement-admission.action.ts';
import { currentMarketCatalogRead } from '../../src/api/current-market-catalog.read.ts';
import { pricingCurrentMarketEvidenceRead } from '../../src/api/pricing-current-market-evidence.read.ts';
import { marketHistoryRead } from '../../src/api/market-history.read.ts';
import {
  COMMERCE_MARKET_CATALOG_TABLES,
  gatewayAssertionRedemptions,
  marketRetirementAdmissions,
  commerceMarketCatalogRelations,
} from '../../src/database/schema.ts';
import { pathToFileURL } from 'node:url';
import { resolveEffectBffModuleHandler } from '@modern-js/bff-effect/effect';
import { defineEffectBff, dispatchEffectBffRequest } from '@modern-js/bff-effect/effect-edge';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import {
  commerceMarketCatalogActionRuntimeDependenciesLive,
  commerceMarketCatalogApiRuntimeFromContext,
  MarketRetirementActionRuntimeLive,
  MarketRetirementRuntimeBindings,
} from '../../api/index.ts';
import { MarketRetirementImpactAuthorityLive } from '../../src/integrations/market-retirement-impact.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import {
  MarketRevisionNativeEvidenceSchema,
  MarketRevisionNativeRetirementReservationSchema,
} from '../support/market-revision-native-protocol.ts';
import { commerceMarketCatalogApiContract } from '../../shared/api.ts';
import { executeCreateMarketWithAuthorization } from '../../src/api/create-market-action-client.ts';
import { executeAssociateStorefrontWithAuthorization } from '../../src/api/associate-storefront-action-client.ts';
import { executeReviseMarketDefinitionWithAuthorization } from '../../src/api/revise-market-definition-action-client.ts';

export const marketRevisionNativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const marketAppId = 'commerce-market-catalog' as const;
const registryModuleId = 'commerce.storefront-registry' as const;
const customerContextModuleId = 'commerce.customer-context' as const;
const identityModuleId = 'core.identity';
const createCorrelation = 'market-create';
const associateCorrelation = 'market-associate';
const storefrontAppId = 'native-storefront' as const;
const moduleKey = 'commerce.market-catalog';
const databaseObservationSchema = Schema.Struct({ observedAt: Schema.DateTimeUtcFromString });
const shift = (at: DateTime.Utc, millis: number) => DateTime.makeUnsafe(DateTime.toEpochMillis(at) + millis);
const actionKeys = [
  createMarketAction,
  reviseMarketDefinitionAction,
  associateStorefrontAction,
  suspendMarketAction,
  activateMarketAction,
  reviseStorefrontAssociationAction,
  removeStorefrontAssociationAction,
  retireMarketAction,
  manageMarketRetirementAdmissionAction,
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
  marketBaseUrl: string,
  retirementManagementExecutor: 'allowed' | 'denied',
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
    COMMERCE_MARKET_CATALOG_TABLES.filter(
      (table) => table !== gatewayAssertionRedemptions && table !== marketRetirementAdmissions,
    ),
    (table) => admin.execute(sql`grant select,insert,update,delete on table ${table} to ${runtimeRole}`, 'objects'),
    { concurrency: 1 },
  );
  yield* admin.execute(
    sql`grant select,insert,update on table ${marketRetirementAdmissions} to ${runtimeRole}`,
    'objects',
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
  const registryScope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit));
  const registry = yield* makeCurrentStorefrontNativeReceiver().pipe(Scope.provide(registryScope));
  const customerContext = yield* makeMarketRetirementNativeReceiver();
  const readOwnerContract = Effect.fn('MarketRevisionNative.readOwnerContract')(function* readOwnerContract(input: {
    readonly appId: string;
    readonly baseUrl: string;
    readonly buildMarker: string;
    readonly directory: string;
    readonly moduleId: string;
  }) {
    const bytes = yield* filesystem
      .readFile(path.join(input.directory, '.output/public/.well-known/ontos-module-manifest.json'))
      .pipe(Effect.mapError((cause) => Object.defineProperty(unavailable(), 'cause', { value: cause })));
    const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
      new TextDecoder().decode(bytes),
    ).pipe(Effect.mapError((cause) => Object.defineProperty(unavailable(), 'cause', { value: cause })));
    if (
      contract.deployment.appId !== input.appId ||
      contract.deployment.buildMarker !== input.buildMarker ||
      contract.manifest.module.id !== input.moduleId
    ) {
      return yield* unavailable();
    }
    const federationManifest =
      contract.manifest.publicSurface.components.length === 0
        ? undefined
        : {
            bytes: yield* filesystem.readFile(path.join(input.directory, '.output/mf-manifest.json')),
            url: new URL('/mf-manifest.json', input.baseUrl).href,
          };
    const observation = {
      appId: input.appId,
      backend: { baseUrl: input.baseUrl, transport: 'node-http' as const },
      contract: { bytes, url: new URL(ONTOS_MODULE_CONTRACT_PATH, input.baseUrl).href },
    };
    if (federationManifest === undefined) {
      return observation;
    }
    return { ...observation, federationManifest };
  });
  // Observe exact freshly built public artifact bytes on disk. These URL locators do not assert HTTP observation.
  const shellOutputDirectory = path.resolve(process.cwd(), '../../apps/shell-super-app/.output');
  const shellRuntimeBytes = yield* filesystem.readFile(
    path.join(shellOutputDirectory, 'public', ONTOS_SHELL_RUNTIME_CONTRACT_PATH.slice(1)),
  );
  const shellRuntime = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
    new TextDecoder().decode(shellRuntimeBytes),
  );
  if (shellRuntime.deployment.appId !== 'shell-super-app') {
    return yield* unavailable();
  }
  const shellReleaseUrl = `https://${shellRuntime.deployment.appId}.example.test/releases/${shellRuntime.deployment.buildMarker}/`;
  // Intact owner-emitted documents and the built Shell observation drive the canonical publisher builder.
  const baseSnapshot = yield* deriveActiveApplicationCompositionSnapshot({
    environment: 'development',
    modules: [
      yield* readOwnerContract({
        appId: marketAppId,
        baseUrl: marketBaseUrl,
        buildMarker: ultramodernApiMarker.buildMarker,
        directory: process.cwd(),
        moduleId: moduleKey,
      }),
      yield* readOwnerContract({
        ...registry.deployment,
        baseUrl: registry.baseUrl,
        directory: path.resolve(process.cwd(), '../storefront-registry'),
        moduleId: registryModuleId,
      }),
      yield* readOwnerContract({
        ...customerContext.deployment,
        baseUrl: customerContext.baseUrl,
        directory: path.resolve(process.cwd(), '../commerce-customer-context'),
        moduleId: customerContextModuleId,
      }),
    ],
    observedAt: yield* DateTime.now,
    shell: {
      federationManifest: {
        bytes: yield* filesystem.readFile(path.join(shellOutputDirectory, 'mf-manifest.json')),
        url: new URL('mf-manifest.json', shellReleaseUrl).href,
      },
      runtimeContract: {
        bytes: shellRuntimeBytes,
        url: new URL(ONTOS_SHELL_RUNTIME_CONTRACT_PATH.slice(1), shellReleaseUrl).href,
      },
    },
    validity: Duration.hours(1),
  });
  const backends = new Map([
    [marketAppId, marketBaseUrl],
    [registry.deployment.appId, registry.baseUrl],
    [customerContext.deployment.appId, customerContext.baseUrl],
  ]);
  const snapshot = {
    ...baseSnapshot,
    composition: sealApiKeyGatewayNativeComposition({
      ...baseSnapshot.composition,
      modules: baseSnapshot.composition.modules.map((module) => {
        const url = backends.get(module.deployment.appId);
        return url === undefined ? module : { ...module, backend: { baseUrl: url, transport: 'node-http' as const } };
      }),
    }),
  };
  yield* isolated.publishInitialComposition(snapshot);
  const shell = yield* makeApiKeyGatewayNativeFixture({
    ownedDatabase: isolated,
    relaySource: { sourceAppId: marketAppId },
    snapshotJson: yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
      snapshot,
    ),
  });
  const connections = {
    adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
    runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
  };
  yield* registry.migrate(connections);
  yield* customerContext.migrate(connections);
  if (shell.relaySourceProviderUserId === undefined) {
    return yield* unavailable();
  }
  const baseConfiguration = {
    actionExecutor: 'manager-only' as const,
    actionKeys: [
      ...actionKeys.filter(
        (key) =>
          retirementManagementExecutor !== 'denied' ||
          key !== manageMarketRetirementAdmissionAction.descriptor.actionKey,
      ),
      bindSelfApiKeyAction.descriptor.actionKey,
      'commerce.storefront-registry.register-storefront-application',
      'commerce.customer-context.reserve-market-retirement',
    ],
    adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
    allowedAudiences: [marketAppId, 'storefront-registry', 'commerce-customer-context'],
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    compositionRevision: snapshot.composition.revision,
    executorProbeActionKeys:
      retirementManagementExecutor === 'denied' ? [manageMarketRetirementAdmissionAction.descriptor.actionKey] : [],
    moduleAccess: 'configured-modules' as const,
    moduleKeys: [moduleKey, registryModuleId, customerContextModuleId],
    runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
  };
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      ...baseConfiguration,
      managerProviderSubjectId: shell.providerUserId,
      readerActionKeys: [bindSelfApiKeyAction.descriptor.actionKey],
      readerProviderSubjectId: shell.relaySourceProviderUserId,
    }),
    (value) => value.close().pipe(Effect.orDie),
  );
  const evidence = Effect.fn('MarketRevisionNative.evidence')(function* evidence() {
    const recorded = yield* fixture.evidence(admin);
    const reservationInvocations = new Set(
      recorded.invocations
        .filter(
          (invocation) =>
            invocation.actionKey === 'commerce.customer-context.reserve-market-retirement' &&
            invocation.status === 'succeeded',
        )
        .map((invocation) => invocation.actionInvocationId),
    );
    const admissions = yield* admin
      .select({ status: marketRetirementAdmissions.status })
      .from(marketRetirementAdmissions)
      .where(eq(marketRetirementAdmissions.tenantId, fixture.tenantId));
    return yield* Schema.decodeUnknownEffect(Schema.toType(MarketRevisionNativeEvidenceSchema))({
      accesses: recorded.accesses.map(({ outcome, outcomeCode, outcomeStage, principalId, servingModuleKey }) => ({
        outcome,
        outcomeCode,
        outcomeStage,
        principalId,
        servingModuleKey,
      })),
      admissions,
      audits: recorded.audits.map(
        ({ actionInvocationId, evidenceJson, outcome, outcomeCode, outcomeStage, principalId }) => ({
          actionInvocationId: actionInvocationId === null ? Option.none() : Option.some(actionInvocationId),
          outcome,
          outcomeCode,
          outcomeStage,
          principalId: principalId === null ? Option.none() : Option.some(principalId),
          retirementReservation:
            actionInvocationId !== null &&
            reservationInvocations.has(actionInvocationId) &&
            outcome === 'succeeded' &&
            Schema.is(MarketRevisionNativeRetirementReservationSchema)(evidenceJson)
              ? Option.some({ lifecycle: evidenceJson.lifecycle, reservationVersion: evidenceJson.reservationVersion })
              : Option.none(),
        }),
      ),
      invocations: recorded.invocations.map(({ actionInvocationId, actionKey, principalId, status }) => ({
        actionInvocationId,
        actionKey,
        principalId: principalId === null ? Option.none() : Option.some(principalId),
        status,
      })),
      outboxCount: recorded.outbox.filter((row) => row.producerModuleKey === moduleKey).length,
      type: 'EVIDENCE',
    });
  });
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
  const associationRef = {
    moduleId: moduleKey,
    resourceId: associationId,
    resourceType: 'commerce.market-catalog.storefront-association',
    tenantId: fixture.tenantId,
  } as const;
  const sellerRef = {
    moduleId: identityModuleId,
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
  yield* fixture.grantResourceAccess(marketRef, fixture.manager.principalId, 'reader');
  yield* fixture.grantContextPermissionAccess(
    { moduleId: customerContextModuleId, permission: 'market.catalog.read' },
    fixture.manager.principalId,
  );
  yield* fixture.grantResourceAccess(secondMarketRef, fixture.manager.principalId, 'writer');
  yield* fixture.grantResourceAccess(associationRef, fixture.manager.principalId, 'writer');
  // Exact test-owned admission. Real Core scope/resource permissions and owner SQL remain active.
  // This does not activate a production provider, default API adapter or publication authority.
  const authorization = Layer.succeed(OwnerAuthorizationOverlay, {
    authorize: (_transaction, input) =>
      Effect.succeed(
        input.scope.tenantId === fixture.tenantId &&
          (input.scope.principalId === fixture.manager.principalId ||
            (input.scope.principalId === fixture.reader.principalId &&
              input.owningModuleKey === identityModuleId &&
              input.operationKey === bindSelfApiKeyAction.descriptor.actionKey &&
              input.scope.legalEntityId === undefined)) &&
          (input.scope.legalEntityId === fixture.legalEntityId || input.scope.legalEntityId === undefined) &&
          ((input.owningModuleKey === moduleKey &&
            input.scope.legalEntityId === fixture.legalEntityId &&
            (actionKeys.includes(input.operationKey) ||
              [currentMarketCatalogRead, pricingCurrentMarketEvidenceRead, marketHistoryRead].some(
                (registration) => registration.descriptor.readKey === input.operationKey,
              ))) ||
            (input.owningModuleKey === identityModuleId &&
              input.operationKey === bindSelfApiKeyAction.descriptor.actionKey) ||
            (input.owningModuleKey === registryModuleId &&
              [
                'commerce.storefront-registry.register-storefront-application',
                'commerce.storefront-registry.api.current-storefront-application',
              ].includes(input.operationKey)))
          ? ('allowed' as const)
          : ('unavailable' as const),
      ),
  });
  yield* fixture.grantResourceAccess(
    {
      moduleId: registryModuleId,
      resourceId: storefrontAppId,
      resourceType: 'commerce.storefront-registry.storefront-application',
    },
    fixture.manager.principalId,
    'writer',
  );
  // Build scoped Core clients once; retained Registry callbacks use this same live context.
  const baseContext = yield* Layer.build(fixture.layer.pipe(Layer.provide(authorization)));
  const binding = yield* shell.issueAndBind(principal).pipe(Effect.provideContext(baseContext));
  const relayBinding = yield* shell.issueRelaySourceAndBind(fixture.reader).pipe(Effect.provideContext(baseContext));
  if (retirementManagementExecutor === 'denied') {
    // Read-only, fully consistent checks for the same real P whose personal key is bound above.
    // Probe-universe membership permits this query only; it never grants Manage execution.
    yield* fixture.verifyActionExecutor({
      actionKey: retireMarketAction.descriptor.actionKey,
      expected: 'allowed',
      principalId: principal.principalId,
    });
    yield* fixture.verifyActionExecutor({
      actionKey: manageMarketRetirementAdmissionAction.descriptor.actionKey,
      expected: 'denied',
      principalId: principal.principalId,
    });
  }

  const context = Context.add(
    baseContext,
    ConfigProvider.ConfigProvider,
    ConfigProvider.orElse(
      ConfigProvider.fromEnvRecord({
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: shell.compositionSourceUrl,
        ONTOS_GATEWAY_ISSUER: shell.issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
        ONTOS_GATEWAY_RELAY_API_KEY: Redacted.value(relayBinding.secret),
        ONTOS_SHELL_GATEWAY_BASE_URL: shell.baseUrl,
      }),
      ConfigProvider.fromEnv(),
    ),
  );
  yield* customerContext.activate({
    compositionRevision: snapshot.composition.revision,
    compositionSourceUrl: shell.compositionSourceUrl,
    issuer: shell.issuer,
    publicJwks: shell.publicJwks,
    runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
  });
  const storefront = yield* registry
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
  yield* storefront
    .register({
      allowedChannels: ['B2C'],
      effectiveInterval: { effectiveFrom: DateTime.formatIso(startsAt) },
      lifecycle: 'ACTIVE',
      reason: 'Native Market revision proof',
      storefrontAppId,
    })
    .pipe(Effect.provideContext(context));
  const revisedAt = shift(now, -1_800_000);
  const before = shift(revisedAt, -1);
  const after = shift(revisedAt, 1);
  return {
    after,
    associationId,
    associationRef,
    before,
    binding,
    closeStorefront: Scope.close(registryScope, Exit.void),
    context,
    databaseConfiguration: yield* parseDatabaseConfig({ DATABASE_URL: isolated.connections.runtime.connectionString }),
    evidence,
    marketRef,
    now,
    principal,
    relayBinding,
    revisedAt,
    sellerRef,
    setCustomerContextState: (state: MarketRevisionNativeCustomerContextState) =>
      fixture.setConfiguredModuleState(customerContextModuleId, state),
    shell,
    snapshot,
  };
});

/** Public, scope-owned test infrastructure. The real Core Actions persist Market truth;
 * generated HTTP reads verify real Shell assertions against the retained native owner runtime.
 * The existing owner runtime redeems assertions against this disposable native owner database.
 */
export const marketRevisionNativeBackend = Effect.fn('MarketRevisionNative.backend')(
  function* makeMarketRevisionNativeFixture(retirementManagementExecutor: 'allowed' | 'denied' = 'allowed') {
    const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
    const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(server.address);
    const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
    const scenario = yield* makeScenario(baseUrl.href, retirementManagementExecutor);
    const { binding, relayBinding, shell } = scenario;
    if (shell === undefined || binding === undefined || relayBinding === undefined) {
      return yield* unavailable();
    }
    const redemptionContext = yield* Layer.build(
      GatewayAssertionRedemptionLive.pipe(
        Layer.provide(GatewayAssertionRedemptionDatabaseLive),
        Layer.provide(Layer.succeed(DatabaseConfig, scenario.databaseConfiguration)),
      ),
    );
    const configuration = Context.get(scenario.context, ConfigProvider.ConfigProvider);
    const dependencies = yield* Layer.build(
      commerceMarketCatalogActionRuntimeDependenciesLive.pipe(
        Layer.provide(Layer.mergeAll(Layer.succeed(DatabaseConfig, scenario.databaseConfiguration), NodeCrypto.layer)),
      ),
    ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, configuration));
    const coreFactory = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
      Layer.provide(Layer.succeedContext(dependencies)),
    );
    const base = Context.get(yield* Layer.build(coreFactory), ActionRuntime);
    const readRuntime = Context.get(
      yield* Layer.build(ReadRuntimeLive.pipe(Layer.provide(Layer.succeedContext(dependencies)))),
      ReadRuntime,
    );
    const crypto = yield* Crypto.Crypto;
    const actionContext = yield* Layer.build(
      MarketRetirementActionRuntimeLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(MarketRetirementRuntimeBindings, {
              base,
              coreFactory,
              crypto,
              readRuntime,
              scopeResolver: Context.get(dependencies, OperationalScopeResolver),
            }),
            MarketRetirementImpactAuthorityLive.pipe(Layer.provide(NodeCrypto.layer)),
          ),
        ),
      ),
    );
    const runtime = yield* commerceMarketCatalogApiRuntimeFromContext.pipe(
      Effect.provideService(ReadRuntime, readRuntime),
      Effect.provideService(ActionRuntime, Context.get(actionContext, ActionRuntime)),
      Effect.provideContext(redemptionContext),
    );
    const configured = defineEffectBff({
      api: runtime.api,
      layer: runtime.layer.pipe(Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, configuration))),
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
    const issueForCommand = (requestCorrelation: string) =>
      issue({
        audience: marketAppId,
        compositionRevision: scenario.snapshot.composition.revision,
        legalEntityId: scenario.sellerRef.resourceId,
        requestCorrelation,
      });
    const createR1 = Effect.fn('MarketRevisionPublicNative.createR1')(function* createR1() {
      const admitted = yield* issueForCommand(createCorrelation);
      const startsAt = shift(scenario.now, -3_600_000);
      const result = yield* executeCreateMarketWithAuthorization(
        {
          channels: ['B2C'],
          effectivePeriod: { startsAt },
          jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
          lifecycle: 'ACTIVE',
          marketCode: 'CZ_PRIMARY',
          marketId: scenario.marketRef.resourceId,
          purpose: 'Original commercial meaning',
          reason: 'Native revision regression',
          sellingLegalEntityRef: scenario.sellerRef,
          supportedLocales: ['cs-CZ'],
        },
        Redacted.value(admitted.credential),
        createCorrelation,
        {
          baseUrl: admitted.baseUrl,
          compositionRevision: scenario.snapshot.composition.revision,
          idempotencyKey: 'create',
        },
      );
      const associationAdmission = yield* issueForCommand(associateCorrelation);
      yield* executeAssociateStorefrontWithAuthorization(
        {
          associationId: scenario.associationId,
          channel: 'B2C',
          effectivePeriod: { startsAt },
          expectedMarketDefinitionRevisionRef: result.definitionRevisionRef,
          marketRef: scenario.marketRef,
          provenance: { kind: 'CONFIGURATION_ACTION', reference: 'native-revision' },
          reason: 'Native eligibility basis',
          sellingLegalEntityRef: scenario.sellerRef,
          storefrontRef: { appId: storefrontAppId, tenantId: scenario.principal.tenantId },
        },
        Redacted.value(associationAdmission.credential),
        associateCorrelation,
        {
          baseUrl: associationAdmission.baseUrl,
          compositionRevision: scenario.snapshot.composition.revision,
          idempotencyKey: 'associate',
        },
      );
      return result;
    });
    const reviseR2 = Effect.fn('MarketRevisionPublicNative.reviseR2')(function* reviseR2(basis: {
      readonly definitionRevisionRef: MarketDefinitionRevisionRef;
      readonly revision: number;
    }) {
      const admitted = yield* issueForCommand('market-revise');
      return yield* executeReviseMarketDefinitionWithAuthorization(
        {
          channels: ['B2C'],
          effectivePeriod: { startsAt: scenario.revisedAt },
          expectedCurrentDefinitionRevisionRef: basis.definitionRevisionRef,
          expectedRevision: basis.revision,
          jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
          marketRef: scenario.marketRef,
          purpose: 'Cosmetic presentation wording',
          reason: 'Cosmetic revision only',
          supportedLocales: ['cs-CZ'],
        },
        Redacted.value(admitted.credential),
        'market-revise',
        {
          baseUrl: admitted.baseUrl,
          compositionRevision: scenario.snapshot.composition.revision,
          idempotencyKey: 'revise',
        },
      );
    });
    return Object.freeze({
      after: scenario.after,
      associationRef: scenario.associationRef,
      baseUrl,
      before: scenario.before,
      closeStorefront: () => scenario.closeStorefront,
      compositionRevision: scenario.snapshot.composition.revision,
      createR1,
      evidence: scenario.evidence,
      issue,
      legalEntityId: scenario.sellerRef.resourceId,
      marketRef: scenario.marketRef,
      now: scenario.now,
      principal: scenario.principal,
      relaySourcePrincipalId: relayBinding.principalId,
      revisedAt: scenario.revisedAt,
      reviseR2,
      sellerRef: scenario.sellerRef,
      setCustomerContextState: scenario.setCustomerContextState,
      snapshot: scenario.snapshot,
      storefrontRef: { appId: storefrontAppId, tenantId: scenario.principal.tenantId },
      tenantId: scenario.principal.tenantId,
    });
  },
);
