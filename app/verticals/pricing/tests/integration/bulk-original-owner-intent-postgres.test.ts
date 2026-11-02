// @effect-diagnostics strictEffectProvide:off -- Integration test entrypoint composes its layers once; expires: 2027-03-31.
import { Buffer } from 'node:buffer';
import { makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  loadDatabaseConnectionPair,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
  TrustedPrincipalContextSchema,
  makeActionRuntimeLive,
  parseDatabaseConfig,
  canonicalizeApplicationComposition,
  validateActiveApplicationCompositionSnapshot,
  makeContextPermissionRelationshipMutationLive,
} from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import {
  PriceProductTargetOutcomeIdentitySchema,
  PriceProductTargetSnapshotSchema,
} from '@app/pricing-contracts/domain/catalog-price-target';
import { SetSupportedCurrenciesV2PayloadSchema } from '@app/pricing-contracts/domain/currency-support';
import { PriceIdentityKeySchema } from '@app/pricing-contracts/domain/price-definition';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices, NodeHttpServer } from '@effect/platform-node';
import {
  Clock,
  Crypto,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Schema,
  Stream,
  Config,
  ConfigProvider,
  Context,
  Queue,
  Deferred,
  Fiber,
} from 'effect';
import type { Cause } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { classifyBulkOriginalChildDiagnostics } from '../unit/support/bulk-original-child-diagnostics.ts';
import {
  ManageProductPriceOperationSchema,
  ManageProductPricesBulkPayloadSchema,
} from '../../shared/actions/manage-product-prices-bulk.ts';
import {
  ManageProductCommercialFeeOperationSchema,
  ManageProductCommercialFeesBulkPayloadSchema,
} from '../../shared/actions/manage-product-commercial-fees-bulk.ts';
import { pricePersistenceForScope } from '../../src/services/price-persistence.service.ts';
import { commercialFeePersistenceForScope } from '../../src/services/commercial-fee-persistence.service.ts';
import { currencySupportPersistenceForScope } from '../../src/persistence/currency-support-persistence.ts';
import { preparePriceSourceEvidence } from '../../src/services/price-source-provenance.service.ts';
import { makeProductPriceBulkCommandPort } from '../../src/services/product-price-bulk.service.ts';
import { productPriceBulkActionInvocationIdFor } from '../../src/services/product-price-bulk-command.port.ts';
import { makeProductCommercialFeeBulkCommandPort } from '../../src/services/product-commercial-fee-bulk.service.ts';
import { productCommercialFeeBulkActionInvocationIdFor } from '../../src/services/product-commercial-fee-bulk-command.port.ts';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import {
  ActiveApplicationCompositionSnapshotSchema,
  makeActiveApplicationCompositionLayer,
} from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS,
  GatewayContextProtectedHeaderSchema,
  SupportedGatewayContextClaimsSchema,
  decodeSupportedGatewayContextClaims,
} from '@app/shared-contracts';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { FetchHttpClient, HttpServerRequest, HttpServerResponse, HttpClient, HttpClientRequest } from 'effect/http';
import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { manageProductPricesBulkActionApiLive } from '../../api/manage-product-prices-bulk-action-server.ts';
import { manageProductCommercialFeesBulkActionApiLive } from '../../api/manage-product-commercial-fees-bulk-action-server.ts';
import { priceResultLookupReadApiLive } from '../../api/price-result-lookup-read-server.ts';
import { commercialFeeResultLookupReadApiLive } from '../../api/commercial-fee-result-lookup-read-server.ts';
import { priceScheduleReadApiLive } from '../../api/price-schedule-read-server.ts';
import { commercialFeeScheduleReadApiLive } from '../../api/commercial-fee-schedule-read-server.ts';
import { executeManageProductPricesBulkWithAuthorization } from '../../src/api/manage-product-prices-bulk-action-client.ts';
import { executeManageProductCommercialFeesBulkWithAuthorization } from '../../src/api/manage-product-commercial-fees-bulk-action-client.ts';
import {
  ExternalPriceInputBoundaryFactoryLive,
  ExternalPriceInputBoundaryFactory,
  ExternalPriceSourceAuthorityGrantSchema,
} from '../../src/services/external-price-input-boundary.service.ts';
import {
  CatalogSelectionGatewayCredentialService,
  PricingCatalogSelectionUnavailable,
} from '../../shared/domain/catalog-selection-gateway-credential.ts';
import type { CatalogSelectionGatewayCredentialIssuer } from '../../shared/domain/catalog-selection-gateway-credential.ts';
import { pricingApi } from '../../shared/api.ts';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { CatalogQuantityHandoffReadySchema } from '@app/catalog/domain/catalog-quantity-handoff';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import { executeProductVariantSnapshotWithAuthorization } from '@app/catalog/api/client';
import { externalPriceSourceAuthorityForScope } from '../../src/persistence/external-price-source-authority-persistence.ts';
import {
  ManageProductPricesBulkActionUnavailableProblemSchema,
  ManageProductPricesBulkActionAuthenticationProblemSchema,
  ManageProductPricesBulkActionForbiddenProblemSchema,
  ManageProductPricesBulkActionConflictProblemSchema,
} from '../../shared/apis/manage-product-prices-bulk-action.ts';
import { PricingCommercialFeeProductTargetSnapshotSchema } from '@app/pricing-contracts/domain/commercial-fee';
import {
  ManageProductCommercialFeesBulkActionConflictProblemSchema,
  ManageProductCommercialFeesBulkActionUnavailableProblemSchema,
} from '../../shared/apis/manage-product-commercial-fees-bulk-action.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]))),
);

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const initialAt = '2026-09-01T09:00:00.000Z';
const scheduledAt = '2026-10-01T09:00:00.000Z';
const recoveryAt = '2026-10-19T09:00:00.000Z';
const instant = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const unexpectedMutation = () => Effect.die('Original-result recovery must not execute or re-admit an owner command');

const journalFingerprint = Effect.fn('BulkOriginalIntent.journalFingerprint')(function* journalFingerprint(connection: {
  readonly connectionString: string;
  readonly database: string;
  readonly user: string;
}) {
  const child = yield* ChildProcess.make(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      'ontos-db',
      'psql',
      '--host',
      'localhost',
      '--username',
      connection.user,
      '--dbname',
      connection.database,
      '--tuples-only',
      '--no-align',
      '--quiet',
      '--command',
      "set time zone 'UTC'; select md5(coalesce(jsonb_agg(to_jsonb(journal) order by to_jsonb(journal)::text)::text,'[]')) from drizzle.__drizzle_migrations_pricing journal",
    ],
    {
      env: {
        PATH: yield* Config.String('PATH'),
        PGPASSWORD: decodeURIComponent(new URL(connection.connectionString).password),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [status, output] = yield* Effect.all(
    [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.runCollect), Stream.runDrain(child.stderr)],
    { concurrency: 3 },
  );
  expect(Number(status)).toBe(0);
  return yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)))(
    output.join('').trim(),
  );
});

// Real source bookkeeping only, matching the schema clone. No fabricated applied rows or business data.
const copyOwnerBookkeeping = Effect.fn('BulkOriginalIntent.copyOwnerBookkeeping')(
  function* copyOwnerBookkeeping(connections: {
    readonly admin: { readonly connectionString: string; readonly database: string; readonly user: string };
  }) {
    const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const before = yield* journalFingerprint(source.admin);
    const dump = yield* ChildProcess.make(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD',
        'ontos-db',
        'pg_dump',
        '--host',
        'localhost',
        '--username',
        source.admin.user,
        '--dbname',
        source.admin.database,
        '--data-only',
        '--column-inserts',
        '--table',
        'drizzle.__drizzle_migrations_pricing',
      ],
      {
        env: {
          PATH: yield* Config.String('PATH'),
          PGPASSWORD: decodeURIComponent(new URL(source.admin.connectionString).password),
        },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const restore = yield* ChildProcess.make(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD',
        'ontos-db',
        'psql',
        '--host',
        'localhost',
        '--username',
        connections.admin.user,
        '--dbname',
        connections.admin.database,
        '--set',
        'ON_ERROR_STOP=1',
        '--quiet',
      ],
      {
        env: {
          PATH: yield* Config.String('PATH'),
          PGPASSWORD: decodeURIComponent(new URL(connections.admin.connectionString).password),
        },
        stderr: 'pipe',
        stdin: dump.stdout,
        stdout: 'pipe',
      },
    );
    const [dumpExit, restoreExit] = yield* Effect.all(
      [
        dump.exitCode,
        restore.exitCode,
        Stream.runDrain(dump.stderr),
        Stream.runDrain(restore.stderr),
        Stream.runDrain(restore.stdout),
      ],
      { concurrency: 5 },
    );
    expect(Number(dumpExit)).toBe(0);
    expect(Number(restoreExit)).toBe(0);
    expect(yield* journalFingerprint(connections.admin)).toBe(before);
    expect(yield* journalFingerprint(source.admin)).toBe(before);
  },
);

// Actual CLI/full immutable journal. Child-only configuration never changes the source database.
const migrateOwner = Effect.fn('BulkOriginalIntent.migrateOwner')(function* migrateOwner(
  connections: {
    readonly admin: { readonly connectionString: string };
    readonly runtime: { readonly connectionString: string };
  },
  command: 'migrate' | 'verify' = 'migrate',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-bulk-original-intent-' });
  const configuration = path.join(directory, 'drizzle.config.mjs');
  yield* fs.writeFileString(
    configuration,
    `export default { dialect:'postgresql', out:process.env.ONTOS_PRICING_BULK_INTENT_MIGRATIONS, schema:process.env.ONTOS_PRICING_BULK_INTENT_SCHEMA, dbCredentials:{url:process.env.DATABASE_ADMIN_URL}, migrations:{schema:'drizzle',table:'__drizzle_migrations_pricing'} };`,
  );
  const child = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      '--filter',
      '@app/pricing',
      'exec',
      ...(command === 'migrate'
        ? ['drizzle-kit', 'migrate', '--config', configuration]
        : ['node', 'scripts/verify-db-schema.mts']),
    ],
    {
      cwd: new URL('../../../../', import.meta.url).pathname,
      env: {
        DATABASE_ADMIN_URL: connections.admin.connectionString,
        DATABASE_URL: connections.runtime.connectionString,
        ONTOS_PRICING_BULK_INTENT_MIGRATIONS: new URL('../../drizzle/', import.meta.url).pathname,
        ONTOS_PRICING_BULK_INTENT_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
      },
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  );
  const [status, stderr, stdout] = yield* Effect.all(
    [
      child.exitCode,
      child.stderr.pipe(Stream.decodeText(), Stream.runCollect),
      child.stdout.pipe(Stream.decodeText(), Stream.runCollect),
    ],
    { concurrency: 3 },
  );
  if (Number(status) !== 0) {
    yield* Effect.logError(
      classifyBulkOriginalChildDiagnostics({
        command,
        exitCode: Number(status),
        stderr: stderr.join(''),
        stdout: stdout.join(''),
      }),
    );
  }
  expect(Number(status)).toBe(0);
});

// Execute the verifier's actual predicate, rather than mirroring its role-set logic in a test.
const verifyAppendOnlyPolicyRoleSets = Effect.fn('BulkOriginalIntent.verifyPolicyRoleSets')(
  function* verifyPolicyRoleSets(connection: { readonly connectionString: string }) {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(new URL('../../scripts/verify-db-schema.mts', import.meta.url).pathname);
    const predicate =
      /and (?<predicate>array\(select role_oid from unnest\(policy\.polroles\)[\s\S]+?end\) as role_oid order by role_oid\))/u.exec(
        source,
      )?.groups?.['predicate'];
    if (predicate === undefined) {
      return yield* Effect.die('The native control must execute the current exact verifier role predicate');
    }
    const client = yield* PgClient.make({ url: Redacted.make(connection.connectionString) });
    const rows = yield* client.unsafe<{
      readonly case_name: string;
      readonly expected: boolean;
      readonly matches: boolean;
    }>(
      `with roles as (
         select array[
           (select oid from pg_catalog.pg_roles where rolname='ontos_runtime'),
           (select oid from pg_catalog.pg_roles where rolname='pricing_management_routine_writer')
         ]::oid[] as exact_roles
       ), cases(case_name, role_oids, expected) as (
         select 'EXACT', exact_roles, true from roles
         union all select 'REVERSED', array[exact_roles[2],exact_roles[1]], true from roles
         union all select 'MISSING_WRITER', array[exact_roles[1]], false from roles
         union all select 'MISSING_RUNTIME', array[exact_roles[2]], false from roles
         union all select 'EXTRA_PUBLIC', exact_roles || array[0::oid], false from roles
         union all select 'PUBLIC_SUBSTITUTION', array[0::oid], false from roles
         union all select 'DUPLICATE_RUNTIME', array[exact_roles[1],exact_roles[1]], false from roles
         union all select 'DUPLICATE_WRITER', exact_roles || array[exact_roles[2]], false from roles
       )
       select cases.case_name, (${predicate}) as matches, cases.expected
       from cases
       cross join lateral (select cases.role_oids as polroles) as policy
       cross join (values ('currency_support_recovery_compensation_receipts')) as relation(relname)
       order by cases.case_name`,
    );
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.matches, row.case_name).toBe(row.expected);
    }
    return yield* Effect.void;
  },
);

// The only DDL target is this scope's disposable database. Source schema stays untouched.
const makeOwnedPriceFeeFixture = Effect.fn('test.makeOwnedPriceFeeFixture')(function* makeOwnedPriceFeeFixture() {
  const composition = yield* makeApplicationCompositionSnapshotFixture(['pricing'], ultramodernApiMarker.buildMarker);
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: composition,
    mode: 'schema-only',
    purpose: 'stabilization-1278-bulk-intent',
  });
  yield* isolated.assertClonedSchema();
  yield* copyOwnerBookkeeping(isolated.connections);
  yield* migrateOwner(isolated.connections);
  yield* verifyAppendOnlyPolicyRoleSets(isolated.connections.runtime);
  yield* migrateOwner(isolated.connections, 'verify');
  return yield* makeNativeReadTestContext({
    connections: {
      admin: { connectionString: Redacted.make(isolated.connections.admin.connectionString) },
      runtime: { connectionString: Redacted.make(isolated.connections.runtime.connectionString) },
    },
    contextPermissions: [],
    moduleId: 'commerce.pricing',
    ownerFixtureRetention: 'retain-complete-context',
  });
});

const seedOwner = Effect.fn('test.bulkOriginalOwnerSeed')(function* seedOwner(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) {
  if (scope.legalEntityId === undefined) {
    return yield* Effect.die('The verified native owner scope must include its Legal Entity');
  }
  const productId = yield* nextId;
  const variantId = yield* nextId;
  const unitId = yield* nextId;
  const key = yield* Schema.decodeEffect(PriceIdentityKeySchema)({
    catalogSelection: {
      productRef: {
        moduleId: 'commerce.catalog',
        resourceId: productId,
        resourceType: 'commerce.catalog.product',
        tenantId: scope.tenantId,
      },
      variantRef: {
        moduleId: 'commerce.catalog',
        resourceId: variantId,
        resourceType: 'commerce.catalog.variant',
        tenantId: scope.tenantId,
      },
    },
    commercialScope: { channelId: 'B2C', marketId: 'CZ', sellingLegalEntityId: scope.legalEntityId },
    currencyCode: 'CZK',
    priceGroupSelector: { kind: 'NO_GROUP' },
    unitBasis: {
      quantity: '1',
      unitRef: {
        moduleId: 'commerce.catalog',
        resourceId: unitId,
        resourceType: 'commerce.catalog.product-unit',
        tenantId: scope.tenantId,
      },
    },
  });
  const support = yield* currencySupportPersistenceForScope(transaction, scope, 'a'.repeat(64));
  expect(
    yield* support.setCurrent({
      ...(yield* Schema.decodeEffect(SetSupportedCurrenciesV2PayloadSchema)({
        expectedState: { state: 'ABSENT' },
        intendedEffectivePeriod: { effectiveFrom: initialAt, effectiveTo: null },
        intent: 'ESTABLISH_CURRENT',
        reason: 'Bulk original intent currency prerequisite',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      })),
      actingPrincipalId: scope.principalId,
      actionInvocationId: yield* nextId,
      tenantId: scope.tenantId,
      trustedOperationAt: instant(initialAt),
    }),
  ).toMatchObject({ outcome: 'CREATED' });
  const identity = yield* Schema.decodeEffect(PriceProductTargetOutcomeIdentitySchema)({
    snapshotId: 'a'.repeat(64),
    target: key.catalogSelection,
    targetId: variantId,
  });
  return { identity, key };
});

const assertionFor = Effect.fn('test.bulkOriginalSourceAssertion')(function* assertionFor(
  key: typeof PriceIdentityKeySchema.Type,
  priceId: string,
  amount: string,
  effectiveAt: string,
  predecessor?: string,
) {
  return yield* Schema.decodeEffect(PriceSourceAssertionInputSchema)({
    lineage:
      predecessor === undefined
        ? { kind: 'INITIAL' }
        : {
            kind: 'SUPERSESSION',
            reason: 'Actual native schedule supersession',
            supersededSourceAssertionId: predecessor,
          },
    mapping: { mappingContractRef: 'native-1278:mapping', mappingContractVersion: '1' },
    originalAssertion: {
      monetaryAmount: { amount, currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      unitBasis: key.unitBasis,
    },
    sourceAssertionId: yield* nextId,
    sourceAuthority: { sourceAuthorityRef: 'native-1278:owner-source', sourceAuthorityVersion: '1' },
    sourceRecord: {
      sourceChangeCorrelation: yield* nextId,
      sourceRecordRef: priceId,
      sourceRecordVersion: predecessor === undefined ? '1' : '2',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'native-1278:source' },
    },
    timing: { importedAt: initialAt, ownerBusinessEffectiveAt: effectiveAt, sourceEffectiveAt: effectiveAt },
  });
});

it.layer(nativeServices, { excludeTestServices: true })((suite) =>
  suite.effect('recovers only the exact native Price schedule intent and never reinterprets its receipt (#1278)', () =>
    Effect.scoped(
      Effect.gen(function* nativePriceOriginalIntent() {
        const fixture = yield* makeOwnedPriceFeeFixture();
        const context = yield* Layer.build(fixture.layer);
        // Catalog identity is an explicit precondition here; this owner-native proof does not activate a provider.
        const original = yield* fixture
          .prepareOwner(
            Effect.fn('test.originalPriceSchedule')(function* originalPriceSchedule(transaction, scope) {
              const { identity, key } = yield* seedOwner(transaction, scope);
              const prices = yield* pricePersistenceForScope(transaction, scope);
              const priceId = yield* nextId;
              const priceRef = {
                moduleId: 'commerce.pricing' as const,
                resourceId: priceId,
                resourceType: 'commerce.pricing.price' as const,
                tenantId: scope.tenantId,
              };
              const firstAssertion = yield* assertionFor(key, priceId, '100', initialAt);
              const firstEvidence = preparePriceSourceEvidence({
                actingPrincipalId: scope.principalId,
                effectiveFrom: initialAt,
                identityKey: key,
                monetaryAmount: { amount: '100', currencyCode: 'CZK' },
                sourceAssertion: firstAssertion,
                tenantId: scope.tenantId,
                trustedOperationAt: instant(initialAt),
              });
              if (firstEvidence.outcome !== 'READY_FOR_CANONICAL_WRITE') {
                return yield* Effect.die('Initial native source evidence is required');
              }
              const defineActionInvocationId = yield* nextId;
              const defineOperation = yield* Schema.decodeEffect(ManageProductPriceOperationSchema)({
                kind: 'DEFINE_PRICE',
                payload: {
                  effectiveFrom: initialAt,
                  identityKey: key,
                  monetaryAmount: { amount: '100', currencyCode: 'CZK' },
                  priceRef,
                  reason: 'Native original Price',
                  sourceAssertion: firstAssertion,
                },
              });
              expect(
                yield* prices.define({
                  actingPrincipalId: scope.principalId,
                  actionInvocationId: defineActionInvocationId,
                  effectiveFrom: initialAt,
                  identityKey: key,
                  monetaryAmount: { amount: '100', currencyCode: 'CZK' },
                  priceRef,
                  reason: 'Native original Price',
                  requestCorrelationId: 'native-1278:define',
                  sourceEvidence: firstEvidence.evidence,
                  trustedOperationAt: instant(initialAt),
                }),
              ).toMatchObject({ outcome: 'CREATED' });
              const before = yield* prices.readSchedule(priceRef, instant(initialAt));
              if (before.outcome !== 'PRICE_SCHEDULE_CURRENT') {
                return yield* Effect.die('Native initial Price schedule is required');
              }
              const sourceAssertion = yield* assertionFor(
                key,
                priceId,
                '90',
                scheduledAt,
                firstAssertion.sourceAssertionId,
              );
              const evidence = preparePriceSourceEvidence({
                actingPrincipalId: scope.principalId,
                effectiveFrom: scheduledAt,
                identityKey: key,
                monetaryAmount: { amount: '90', currencyCode: 'CZK' },
                sourceAssertion,
                tenantId: scope.tenantId,
                trustedOperationAt: instant(initialAt),
              });
              if (evidence.outcome !== 'READY_FOR_CANONICAL_WRITE') {
                return yield* Effect.die('Native schedule source evidence is required');
              }
              const operation = yield* Schema.decodeEffect(ManageProductPriceOperationSchema)({
                kind: 'REVISE_PRICE',
                payload: {
                  effectivePeriod: { effectiveFrom: scheduledAt, effectiveTo: null },
                  expectedScheduleRevision: before.schedule.scheduleRevision,
                  intent: 'SCHEDULE_REVISION',
                  monetaryAmount: { amount: '90', currencyCode: 'CZK' },
                  priceRef,
                  reason: 'Original scheduled Price intent',
                  sourceAssertion,
                },
              });
              if (operation.kind !== 'REVISE_PRICE' || operation.payload.intent !== 'SCHEDULE_REVISION') {
                return yield* Effect.die('Exact Price schedule operation is required');
              }
              const intentId = `native-1278:price:${yield* nextId}`;
              const actionInvocationId = productPriceBulkActionInvocationIdFor(scope.tenantId, intentId);
              const { sourceAssertion: _sourceAssertion, ...payload } = operation.payload;
              expect(
                yield* prices.revise({
                  ...payload,
                  actingPrincipalId: scope.principalId,
                  actionInvocationId,
                  requestCorrelationId: 'native-1278:K1',
                  sourceEvidence: evidence.evidence,
                  trustedOperationAt: instant(initialAt),
                }),
              ).toMatchObject({ outcome: 'REVISED' });
              return {
                actionInvocationId,
                defineActionInvocationId,
                defineOperation,
                identity,
                intentId,
                operation,
                priceRef,
              };
            }),
          )
          .pipe(Effect.provideContext(context));
        // The first transaction has really settled. Its response is now intentionally discarded.
        yield* fixture
          .prepareOwner(
            Effect.fn('test.recoverOriginalPriceSchedule')(function* recoverOriginalPriceSchedule(transaction, scope) {
              const prices = yield* pricePersistenceForScope(transaction, scope);
              expect(
                yield* prices.lookupOriginalResult({
                  actionInvocationId: original.defineActionInvocationId,
                  operation: original.defineOperation,
                }),
              ).toMatchObject({ originalIntentMatches: true, outcome: 'PRICE_ACTION_RESULT_FOUND' });
              expect(
                yield* prices.lookupOriginalResult({
                  actionInvocationId: original.defineActionInvocationId,
                  operation: original.operation,
                }),
              ).toMatchObject({ originalIntentMatches: false, outcome: 'PRICE_ACTION_RESULT_FOUND' });
              expect(
                yield* prices.lookupOriginalResult({
                  actionInvocationId: yield* nextId,
                  operation: original.operation,
                }),
              ).toMatchObject({ outcome: 'PRICE_ACTION_RESULT_ABSENT' });
              const receipt = yield* prices.lookupResult({ actionInvocationId: original.actionInvocationId });
              expect(receipt).not.toHaveProperty('originalIntentMatches');
              const schedule = yield* prices.readSchedule(original.priceRef, instant(recoveryAt));
              if (schedule.outcome !== 'PRICE_SCHEDULE_CURRENT' || schedule.schedule.current === undefined) {
                return yield* Effect.die('Scheduled Price must be Current at recovery');
              }
              const { current } = schedule.schedule;
              const port = makeProductPriceBulkCommandPort({
                defineServices: {
                  assessCatalogSelection: unexpectedMutation,
                  assessCommercialContext: unexpectedMutation,
                  assessExternalPriceInput: unexpectedMutation,
                  define: unexpectedMutation,
                  loadCurrencySupport: unexpectedMutation,
                },
                persistence: prices,
                reviseServices: {
                  assessExternalPriceInput: unexpectedMutation,
                  readSchedule: unexpectedMutation,
                  revise: unexpectedMutation,
                },
              });
              const trusted = {
                actionInvocationId: yield* nextId,
                compositionRevision: 'a'.repeat(64),
                principalContext: scope,
                requestCorrelationId: 'native-1278:K2',
                trustedOperationAt: instant(recoveryAt),
              };
              const command = {
                identity: original.identity,
                intentId: original.intentId,
                operation: original.operation,
                targetCorrelationRef: 'native-1278:target',
                trusted,
              };
              expect(yield* port.reconcileAuthorizedExactPriceAction(command)).toMatchObject({
                outcome: { outcome: 'APPLIED' },
                status: 'RESOLVED',
              });
              if (
                original.operation.kind !== 'REVISE_PRICE' ||
                original.operation.payload.intent !== 'SCHEDULE_REVISION'
              ) {
                return yield* Effect.die('Retained Price schedule operation is required');
              }
              const changed = [
                {
                  ...original.operation,
                  payload: {
                    ...original.operation.payload,
                    effectivePeriod: {
                      ...original.operation.payload.effectivePeriod,
                      effectiveFrom: '2026-10-02T09:00:00.000Z',
                    },
                  },
                },
                {
                  ...original.operation,
                  payload: {
                    ...original.operation.payload,
                    effectivePeriod: {
                      ...original.operation.payload.effectivePeriod,
                      effectiveTo: '2026-10-30T09:00:00.000Z',
                    },
                  },
                },
                {
                  ...original.operation,
                  payload: {
                    ...original.operation.payload,
                    expectedScheduleRevision: original.operation.payload.expectedScheduleRevision + 1,
                  },
                },
                {
                  ...original.operation,
                  payload: { ...original.operation.payload, reason: 'Changed original reason' },
                },
                {
                  ...original.operation,
                  payload: {
                    ...original.operation.payload,
                    sourceAssertion: {
                      ...original.operation.payload.sourceAssertion,
                      mapping: { ...original.operation.payload.sourceAssertion.mapping, mappingContractVersion: '2' },
                    },
                  },
                },
                {
                  kind: 'REVISE_PRICE',
                  payload: {
                    expectedCurrent: {
                      effectivePeriod: current.effectivePeriod,
                      priceRef: original.priceRef,
                      revision: current.definition.revision.revision,
                      revisionId: current.definition.revision.revisionId,
                      scheduleRevision: schedule.schedule.scheduleRevision,
                    },
                    intent: 'RETIRE_CURRENT',
                    priceRef: original.priceRef,
                    reason: 'Retire the Current Price',
                  },
                },
              ];
              for (const value of changed) {
                const operation = yield* Schema.decodeUnknownEffect(ManageProductPriceOperationSchema)(value);
                expect(yield* port.reconcileAuthorizedExactPriceAction({ ...command, operation })).toEqual({
                  outcome: { outcome: 'CONFLICT', reasonCode: 'IDEMPOTENCY_CONFLICT' },
                  status: 'RESOLVED',
                });
              }
              expect(yield* prices.lookupResult({ actionInvocationId: original.actionInvocationId })).toEqual(receipt);
              const after = yield* prices.readSchedule(original.priceRef, instant(recoveryAt));
              if (after.outcome !== 'PRICE_SCHEDULE_CURRENT') {
                return yield* Effect.die('Original Price schedule must remain');
              }
              expect(after.schedule.revisions).toEqual(schedule.schedule.revisions);
              expect(after.schedule.scheduleRevision).toBe(schedule.schedule.scheduleRevision);
              return yield* Effect.void;
            }),
          )
          .pipe(Effect.provideContext(context));
      }),
    ),
  ),
);

it.layer(nativeServices, { excludeTestServices: true })((suite) =>
  suite.effect('keeps a native Fee schedule distinct from retirement and preserves its immutable receipt (#1278)', () =>
    Effect.scoped(
      Effect.gen(function* nativeFeeOriginalIntent() {
        const fixture = yield* makeOwnedPriceFeeFixture();
        const context = yield* Layer.build(fixture.layer);
        const original = yield* fixture
          .prepareOwner(
            Effect.fn('test.originalFeeSchedule')(function* originalFeeSchedule(transaction, scope) {
              const { identity, key } = yield* seedOwner(transaction, scope);
              const fees = yield* commercialFeePersistenceForScope(transaction, scope);
              const catalogTargetEvidence = {
                capturedAt: initialAt,
                catalogOwnerRevision: 'native-1278:catalog-precondition',
                productRef: key.catalogSelection.productRef,
                snapshotId: identity.snapshotId,
                targetId: identity.targetId,
                variantRef: key.catalogSelection.variantRef,
              };
              const define = {
                catalogTargetEvidence,
                configuredAmount: { amount: '20', currencyCode: 'CZK' as const },
                effectivePeriod: { effectiveFrom: initialAt, effectiveTo: '2026-09-20T09:00:00.000Z' },
                identityKey: {
                  calculationBasis: { kind: 'FIXED_PER_LINE' as const },
                  commercialScope: key.commercialScope,
                  currencyCode: 'CZK' as const,
                  family: 'RECYCLING_FEE' as const,
                  monetaryBoundary: 'PRE_TAX' as const,
                  target: { variantRef: key.catalogSelection.variantRef },
                },
                reason: 'Native finite initial Fee',
              };
              const defineActionInvocationId = yield* nextId;
              const defineOperation = yield* Schema.decodeEffect(ManageProductCommercialFeeOperationSchema)({
                kind: 'DEFINE_COMMERCIAL_FEE',
                payload: define,
              });
              expect(
                yield* fees.define({
                  ...define,
                  actingPrincipalId: scope.principalId,
                  actionInvocationId: defineActionInvocationId,
                  requestCorrelationId: 'native-1278:define-fee',
                  trustedOperationAt: instant(initialAt),
                }),
              ).toMatchObject({ outcome: 'COMMERCIAL_FEE_CREATED' });
              const before = yield* fees.readSchedule({
                identityKey: define.identityKey,
                trustedOperationAt: instant(initialAt),
              });
              if (before.outcome !== 'COMMERCIAL_FEE_SCHEDULE') {
                return yield* Effect.die('Initial finite Fee schedule is required');
              }
              const operation = yield* Schema.decodeEffect(ManageProductCommercialFeeOperationSchema)({
                kind: 'REVISE_COMMERCIAL_FEE',
                payload: {
                  catalogTargetEvidence,
                  configuredAmount: define.configuredAmount,
                  effectivePeriod: { effectiveFrom: scheduledAt, effectiveTo: '2026-10-30T09:00:00.000Z' },
                  expectedScheduleRevision: before.schedule.scheduleRevision,
                  identityKey: define.identityKey,
                  intent: 'SCHEDULE_REVISION',
                  reason: 'Original nonoverlapping Fee schedule',
                },
              });
              if (operation.kind !== 'REVISE_COMMERCIAL_FEE' || operation.payload.intent !== 'SCHEDULE_REVISION') {
                return yield* Effect.die('Exact Fee schedule operation is required');
              }
              const intentId = `native-1278:fee:${yield* nextId}`;
              const actionInvocationId = productCommercialFeeBulkActionInvocationIdFor(scope.tenantId, intentId);
              expect(
                yield* fees.revise({
                  ...operation.payload,
                  actingPrincipalId: scope.principalId,
                  actionInvocationId,
                  requestCorrelationId: 'native-1278:K1',
                  trustedOperationAt: instant(initialAt),
                }),
              ).toMatchObject({ outcome: 'COMMERCIAL_FEE_REVISED' });
              return {
                actionInvocationId,
                catalogTargetEvidence,
                defineActionInvocationId,
                defineOperation,
                identity,
                identityKey: define.identityKey,
                intentId,
                operation,
              };
            }),
          )
          .pipe(Effect.provideContext(context));
        yield* fixture
          .prepareOwner(
            Effect.fn('test.recoverOriginalFeeSchedule')(function* recoverOriginalFeeSchedule(transaction, scope) {
              const fees = yield* commercialFeePersistenceForScope(transaction, scope);
              expect(
                yield* fees.lookupOriginalResult({
                  actionInvocationId: original.defineActionInvocationId,
                  operation: original.defineOperation,
                }),
              ).toMatchObject({ originalIntentMatches: true, outcome: 'COMMERCIAL_FEE_ACTION_RESULT_FOUND' });
              expect(
                yield* fees.lookupOriginalResult({
                  actionInvocationId: original.defineActionInvocationId,
                  operation: original.operation,
                }),
              ).toMatchObject({ originalIntentMatches: false, outcome: 'COMMERCIAL_FEE_ACTION_RESULT_FOUND' });
              expect(
                yield* fees.lookupOriginalResult({
                  actionInvocationId: yield* nextId,
                  operation: original.operation,
                }),
              ).toMatchObject({ outcome: 'COMMERCIAL_FEE_ACTION_RESULT_ABSENT' });
              const receipt = yield* fees.lookupResult({ actionInvocationId: original.actionInvocationId });
              expect(receipt).not.toHaveProperty('originalIntentMatches');
              const schedule = yield* fees.readSchedule({
                identityKey: original.identityKey,
                trustedOperationAt: instant(recoveryAt),
              });
              if (schedule.outcome !== 'COMMERCIAL_FEE_SCHEDULE' || schedule.schedule.current === undefined) {
                return yield* Effect.die('Scheduled Fee must be Current at recovery');
              }
              const { current } = schedule.schedule;
              const port = makeProductCommercialFeeBulkCommandPort({
                defineServices: {
                  define: unexpectedMutation,
                  loadCurrencySupport: unexpectedMutation,
                  validateCatalogTarget: unexpectedMutation,
                },
                persistence: fees,
                reviseServices: {
                  loadCurrencySupport: unexpectedMutation,
                  revise: unexpectedMutation,
                  validateCatalogTarget: unexpectedMutation,
                },
              });
              const command = {
                catalogTargetEvidence: original.catalogTargetEvidence,
                identity: original.identity,
                intentId: original.intentId,
                operation: original.operation,
                targetCorrelationRef: 'native-1278:target',
                trusted: {
                  actionInvocationId: yield* nextId,
                  compositionRevision: 'a'.repeat(64),
                  principalContext: scope,
                  requestCorrelationId: 'native-1278:K2',
                  trustedOperationAt: instant(recoveryAt),
                },
              };
              expect(yield* port.reconcileAuthorizedCommercialFeeAction(command)).toMatchObject({
                outcome: { outcome: 'SCHEDULED' },
                status: 'RESOLVED',
              });
              const retirement = yield* Schema.decodeEffect(ManageProductCommercialFeeOperationSchema)({
                kind: 'REVISE_COMMERCIAL_FEE',
                payload: {
                  effectiveTo: '2026-10-20T09:00:00.000Z',
                  expectedCurrent: {
                    effectivePeriod: current.effectivePeriod,
                    feeRef: schedule.schedule.feeRef,
                    identityKey: original.identityKey,
                    revision: current.definition.revision.revision,
                    revisionId: current.definition.revision.revisionId,
                    scheduleRevision: schedule.schedule.scheduleRevision,
                  },
                  identityKey: original.identityKey,
                  intent: 'RETIRE_CURRENT',
                  reason: 'Retire the Current Fee',
                },
              });
              expect(yield* port.reconcileAuthorizedCommercialFeeAction({ ...command, operation: retirement })).toEqual(
                {
                  outcome: { outcome: 'CONFLICT', reasonCode: 'IDEMPOTENCY_CONFLICT' },
                  status: 'RESOLVED',
                },
              );
              if (
                original.operation.kind !== 'REVISE_COMMERCIAL_FEE' ||
                original.operation.payload.intent !== 'SCHEDULE_REVISION'
              ) {
                return yield* Effect.die('Retained Fee schedule operation is required');
              }
              for (const value of [
                {
                  ...original.operation,
                  payload: {
                    ...original.operation.payload,
                    effectivePeriod: {
                      ...original.operation.payload.effectivePeriod,
                      effectiveTo: '2026-10-29T09:00:00.000Z',
                    },
                  },
                },
                {
                  ...original.operation,
                  payload: {
                    ...original.operation.payload,
                    expectedScheduleRevision: original.operation.payload.expectedScheduleRevision + 1,
                  },
                },
              ]) {
                const operation = yield* Schema.decodeUnknownEffect(ManageProductCommercialFeeOperationSchema)(value);
                expect(yield* port.reconcileAuthorizedCommercialFeeAction({ ...command, operation })).toMatchObject({
                  outcome: { outcome: 'CONFLICT', reasonCode: 'IDEMPOTENCY_CONFLICT' },
                  status: 'RESOLVED',
                });
              }
              expect(yield* fees.lookupResult({ actionInvocationId: original.actionInvocationId })).toEqual(receipt);
              const after = yield* fees.readSchedule({
                identityKey: original.identityKey,
                trustedOperationAt: instant(recoveryAt),
              });
              if (after.outcome !== 'COMMERCIAL_FEE_SCHEDULE') {
                return yield* Effect.die('Original Fee schedule must remain');
              }
              expect(after.schedule.revisions).toEqual(schedule.schedule.revisions);
              expect(after.schedule.scheduleRevision).toBe(schedule.schedule.scheduleRevision);
              return yield* Effect.void;
            }),
          )
          .pipe(Effect.provideContext(context));
      }),
    ),
  ),
);

// Closed test-infrastructure errors; no raw signing material or underlying cause enters diagnostics.
class BulkOriginalIntentInfrastructureUnavailable extends Schema.TaggedError<BulkOriginalIntentInfrastructureUnavailable>()(
  'BulkOriginalIntentInfrastructureUnavailable',
  {
    stage: Schema.Literals([
      'signing-key',
      'public-key',
      'assertion-sign',
      'composition-digest',
      'http-adapter',
      'http-dispose',
      'child-protocol',
    ]),
  },
) {}
const bulkInfrastructureUnavailable = (
  stage:
    | 'signing-key'
    | 'public-key'
    | 'assertion-sign'
    | 'composition-digest'
    | 'http-adapter'
    | 'http-dispose'
    | 'child-protocol',
) => new BulkOriginalIntentInfrastructureUnavailable({ stage });

type BulkTestPrincipal = typeof TrustedPrincipalContextSchema.Type;
type BulkTestComposition = typeof ActiveApplicationCompositionSnapshotSchema.Type;

// Real WebCrypto signing. The key exists only within the isolated acceptance scope.
const makeBulkTestSigningAuthority = Effect.fn('BulkOriginalIntent.makeTestSigningAuthority')(
  function* makeBulkTestSigningAuthority(clock: Clock.Clock) {
    const signingCrypto = yield* Crypto.Crypto;
    const keys = yield* Effect.tryPromise({
      catch: () => bulkInfrastructureUnavailable('signing-key'),
      try: () => globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']),
    });
    if (!('privateKey' in keys)) {
      return yield* bulkInfrastructureUnavailable('signing-key');
    }
    const publicKey = yield* Effect.tryPromise({
      catch: () => bulkInfrastructureUnavailable('public-key'),
      try: () => globalThis.crypto.subtle.exportKey('jwk', keys.publicKey),
    });
    const kid = 'bulk-original-intent-owned-native';
    const issuer = 'https://bulk-original-intent-native.ontos.test';
    const publicJwkSchema = Schema.Struct({
      crv: Schema.Literal('Ed25519'),
      kty: Schema.Literal('OKP'),
      x: Schema.String,
    });
    const publicJwk = yield* Schema.decodeUnknownEffect(publicJwkSchema)(publicKey);
    const jwks = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          keys: Schema.Array(
            Schema.Struct({
              ...publicJwkSchema.fields,
              alg: Schema.Literal('EdDSA'),
              kid: Schema.String,
              use: Schema.Literal('sig'),
            }),
          ),
        }),
      ),
    )({ keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }] });
    const issue = Effect.fn('BulkOriginalIntent.issueTestAssertion')(function* issue(input: {
      readonly actor: BulkTestPrincipal;
      readonly audience: 'catalog' | 'pricing';
      readonly buildMarker: string;
      readonly compositionRevision: string;
      // Omit for every positive invocation. Supply a genuine past instant ONLY for the expired-credential control.
      readonly issuedAt?: DateTime.Utc;
    }) {
      const issuedAt = input.issuedAt ?? DateTime.makeUnsafe(yield* clock.currentTimeMillis);
      const now = Math.floor(DateTime.toEpochMillis(issuedAt) / 1000);
      const header = Buffer.from(
        yield* Schema.encodeEffect(Schema.fromJsonString(GatewayContextProtectedHeaderSchema))({
          alg: 'EdDSA',
          kid,
          typ: 'JWT',
        }),
      ).toString('base64url');
      const claims = yield* decodeSupportedGatewayContextClaims({
        aud: input.audience,
        compositionRevision: input.compositionRevision,
        exp: now + GATEWAY_ASSERTION_TTL_SECONDS,
        iat: now,
        iss: issuer,
        jti: yield* signingCrypto.randomUUIDv4(),
        principal: input.actor,
        sub: input.actor.principalId,
        targetBuildMarker: input.buildMarker,
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      });
      const encoded = Buffer.from(
        yield* Schema.encodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))(claims),
      ).toString('base64url');
      const content = `${header}.${encoded}`;
      const signature = yield* Effect.tryPromise({
        catch: () => bulkInfrastructureUnavailable('assertion-sign'),
        try: () => globalThis.crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(content)),
      });
      return `Bearer ${content}.${Buffer.from(signature).toString('base64url')}`;
    });
    return { issue, issuer, jwks };
  },
);

type BulkTestSigningAuthority = Effect.Success<ReturnType<typeof makeBulkTestSigningAuthority>>;

interface BulkRegisteredRuntimeInput {
  readonly actor: BulkTestPrincipal;
  readonly catalog: {
    // Explicit tenant-only projection of the same persisted Principal/binding. Both used Catalog reads forbid LE.
    readonly actor: BulkTestPrincipal;
    readonly baseUrl: URL;
    readonly buildMarker: string;
    readonly compositionRevision: string;
  };
  // Must be the actual two-owner snapshot, already published in this owned database.
  readonly composition: BulkTestComposition;
  readonly runtimeConnectionString: Redacted.Redacted;
  readonly signing: BulkTestSigningAuthority;
}

// Public production Core wiring; no live-operations.layer, lock override, custom repository or handler replacement.
const bulkRegisteredRuntime = (input: BulkRegisteredRuntimeInput) => {
  const database = Layer.effect(
    DatabaseConfig,
    parseDatabaseConfig({ DATABASE_URL: Redacted.value(input.runtimeConnectionString) }),
  );
  const persistence = CorePersistenceLive.pipe(Layer.provide(database));
  const states = TenantModuleStateServiceLive.pipe(Layer.provide(persistence));
  const gate = ModuleStateGateLive.pipe(Layer.provide(states));
  const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(gate));
  const scopes = OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(persistence, ContextAccessLive)));
  const namespace = staffAuthenticationNamespaceRegistryLayer(['pricing']);
  const composition = makeActiveApplicationCompositionLayer(Effect.succeed(input.composition));
  const common = Layer.mergeAll(persistence, ContextAccessLive, gate, gateway, scopes, namespace, composition);
  const actions = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
    Layer.provide(Layer.mergeAll(common, ActionRepositoryLive, ActionPermissionLive)),
    Layer.provide(NodeCrypto.layer),
  );
  const reads = ReadRuntimeLive.pipe(Layer.provide(common), Layer.provide(NodeCrypto.layer));
  // TEST authority only: constrain identity/context/destination; never bypass Catalog's generated executor or policy.
  const catalogCredentials = Layer.succeed(CatalogSelectionGatewayCredentialService, {
    issue: Effect.fn('BulkOriginalIntent.issueCatalogCredential')(function* issueCatalogCredential(
      request: Parameters<CatalogSelectionGatewayCredentialIssuer['issue']>[0],
    ) {
      if (
        request.audience !== 'catalog' ||
        request.compositionRevision !== input.composition.composition.revision ||
        request.compositionRevision !== input.catalog.compositionRevision ||
        request.legalEntityId !== input.actor.legalEntityId ||
        input.catalog.actor.legalEntityId !== undefined ||
        input.catalog.actor.tenantId !== input.actor.tenantId ||
        input.catalog.actor.principalId !== input.actor.principalId ||
        input.catalog.baseUrl.protocol !== 'http:' ||
        input.catalog.baseUrl.hostname !== '127.0.0.1' ||
        input.catalog.baseUrl.username !== '' ||
        input.catalog.baseUrl.password !== '' ||
        input.catalog.baseUrl.search !== '' ||
        input.catalog.baseUrl.hash !== ''
      ) {
        return yield* new PricingCatalogSelectionUnavailable({
          code: 'pricing_catalog_selection_unavailable',
          reason: 'Owned TEST Catalog gateway identity or destination mismatch',
          retryable: true,
        });
      }
      const credential = yield* input.signing
        .issue({
          actor: input.catalog.actor,
          audience: 'catalog',
          buildMarker: input.catalog.buildMarker,
          compositionRevision: request.compositionRevision,
        })
        .pipe(
          Effect.mapError(
            () =>
              new PricingCatalogSelectionUnavailable({
                code: 'pricing_catalog_selection_unavailable',
                reason: 'Owned TEST Catalog assertion encoding failed',
                retryable: true,
              }),
          ),
        );
      return { baseUrl: input.catalog.baseUrl, credential: Redacted.make(credential) };
    }),
  });
  // Keep these services in the provided HTTP context: registered Action factories resolve them during invocation.
  return Layer.mergeAll(actions, reads, namespace, ExternalPriceInputBoundaryFactoryLive, catalogCredentials);
};

const makeRegisteredBulkHttp = Effect.fn('BulkOriginalIntent.makeRegisteredHttp')(function* makeRegisteredBulkHttp(
  input: BulkRegisteredRuntimeInput,
) {
  const runtimeContext = yield* Layer.build(bulkRegisteredRuntime(input));
  // TEST limitation: atomic in-process single-use redemption, not production durable redemption configuration.
  const consumed = new Set<string>();
  const redemption = Layer.succeed(GatewayAssertionRedemptionService, {
    consume: ({ jti }) =>
      Effect.suspend(() => {
        if (consumed.has(jti)) {
          return Effect.fail(
            new GatewayAssertionReplayError({
              reason: 'Owned TEST Pricing assertion already redeemed',
            }),
          );
        }
        consumed.add(jti);
        return Effect.void;
      }),
  });
  const encodedComposition = yield* Schema.encodeEffect(
    Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
  )(input.composition);
  const compositionSource = Layer.succeed(ActiveApplicationCompositionSource, {
    load: Effect.succeed(encodedComposition),
  });
  const principalVerifier = ActionPrincipalVerifierLive.pipe(
    Layer.provide(makeActiveApplicationCompositionLayer(Effect.succeed(input.composition))),
    Layer.provide(compositionSource),
    Layer.provide(redemption),
    Layer.provide(Layer.succeedContext(runtimeContext)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: input.signing.issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: input.signing.jwks,
        }),
      ),
    ),
  );
  const requestServices = Layer.mergeAll(
    Layer.succeedContext(runtimeContext),
    principalVerifier,
    compositionSource,
    redemption,
  );
  const handlers = Layer.mergeAll(
    manageProductPricesBulkActionApiLive,
    manageProductCommercialFeesBulkActionApiLive,
    priceResultLookupReadApiLive,
    commercialFeeResultLookupReadApiLive,
    priceScheduleReadApiLive,
    commercialFeeScheduleReadApiLive,
  ).pipe(Layer.provide(requestServices));
  const app = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(
          HttpApi.make('PricingApi')
            .add(pricingApi.groups.manageProductPricesBulkAction)
            .add(pricingApi.groups.manageProductCommercialFeesBulkAction)
            .add(pricingApi.groups.priceResultLookup)
            .add(pricingApi.groups.commercialFeeResultLookup)
            .add(pricingApi.groups.priceSchedule)
            .add(pricingApi.groups.commercialFeeSchedule),
        ).pipe(
          Layer.provide(handlers),
          HttpRouter.provideRequest(requestServices),
          Layer.provide(HttpServer.layerServices),
          Layer.provide(NodeServices.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeCrypto.layer),
        ),
        { disableLogger: true },
      ),
    ),
    (value) =>
      Effect.tryPromise({
        catch: () => bulkInfrastructureUnavailable('http-dispose'),
        try: value.dispose.bind(value),
      }).pipe(Effect.orDie),
  );
  const serverContext = yield* Layer.build(NodeHttpServer.layerTest);
  const server = Context.get(serverContext, HttpServer.HttpServer);
  const emptyContext = Context.makeUnsafe<unknown>(new Map());
  yield* server.serve(
    Effect.gen(function* forwardBulkHttp() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const web = yield* HttpServerRequest.toWeb(request);
      return HttpServerResponse.fromWeb(
        yield* Effect.tryPromise({
          catch: () => bulkInfrastructureUnavailable('http-adapter'),
          try: () => app.handler(web, emptyContext),
        }),
      );
    }),
  );
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(server.address);
  const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
  const issuePricing = (actor: BulkTestPrincipal = input.actor) =>
    input.signing.issue({
      actor,
      audience: 'pricing',
      buildMarker: ultramodernApiMarker.buildMarker,
      compositionRevision: input.composition.composition.revision,
    });
  // These wrappers always obtain a fresh assertion, including exact replay under a fresh outer invocation.
  // For explicit credential-replay/expired/wrong-audience controls invoke the generated client directly.
  const price = (
    payload: Parameters<typeof executeManageProductPricesBulkWithAuthorization>[0],
    idempotencyKey: string,
  ) =>
    Effect.gen(function* publicPriceBulk() {
      return yield* executeManageProductPricesBulkWithAuthorization(payload, yield* issuePricing(), yield* nextId, {
        baseUrl,
        compositionRevision: input.composition.composition.revision,
        idempotencyKey,
      });
    });
  const fee = (
    payload: Parameters<typeof executeManageProductCommercialFeesBulkWithAuthorization>[0],
    idempotencyKey: string,
  ) =>
    Effect.gen(function* publicFeeBulk() {
      return yield* executeManageProductCommercialFeesBulkWithAuthorization(
        payload,
        yield* issuePricing(),
        yield* nextId,
        {
          baseUrl,
          compositionRevision: input.composition.composition.revision,
          idempotencyKey,
        },
      );
    });
  return { baseUrl, context: runtimeContext, fee, issuePricing, price };
});

// Closed private process DTOs are decoded locally; no foreign private source import.
const protocolVersion = 'ontos.catalog.whole-candidate.fixture.v1' as const;
const version = protocolVersion;
const legalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const WholeCandidateCatalogBootstrapSchema = Schema.Struct({
  actor: TrustedPrincipalContextSchema,
  composition: ActiveApplicationCompositionSnapshotSchema,
  databaseName: Schema.String.check(Schema.isPattern(/^ontos_test_[a-z0-9_]+$/u)),
  issuer: Schema.String,
  jwks: Schema.String,
  legalEntityId: legalEntityIdSchema,
  runtimeConnectionString: Schema.RedactedFromValue(Schema.String),
  type: Schema.Literal('bootstrap'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogPrepareSchema = Schema.Struct({
  authorizations: Schema.Tuple([
    Schema.RedactedFromValue(Schema.String),
    Schema.RedactedFromValue(Schema.String),
    Schema.RedactedFromValue(Schema.String),
  ]),
  type: Schema.Literal('prepare'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogReviseSchema = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  type: Schema.Literal('revise-first-unit'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const StopSchema = Schema.Struct({ type: Schema.Literal('stop'), version: Schema.Literal(protocolVersion) }).annotate({
  parseOptions: { onExcessProperty: 'error' },
});
const WholeCandidateCatalogCommandSchema = Schema.Union([
  WholeCandidateCatalogBootstrapSchema,
  WholeCandidateCatalogPrepareSchema,
  WholeCandidateCatalogReviseSchema,
  StopSchema,
]);
const selectionsSchema = Schema.Tuple([CatalogSelectionSchema, CatalogSelectionSchema, CatalogSelectionSchema]);
const unitsSchema = Schema.Tuple([ProductUnitRefSchema, ProductUnitRefSchema, ProductUnitRefSchema]);
const publicFields = {
  actor: TrustedPrincipalContextSchema,
  buildMarker: Schema.String,
  compositionRevision: Schema.String,
  legalEntityId: legalEntityIdSchema,
  port: Schema.Int,
  selections: selectionsSchema,
  units: unitsSchema,
  version: Schema.Literal(protocolVersion),
};
const WholeCandidateCatalogProducedSchema = Schema.Struct({
  ...publicFields,
  type: Schema.Literal('produced'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogReadySchema = Schema.Struct({
  ...publicFields,
  handoffs: Schema.Tuple([
    CatalogQuantityHandoffReadySchema,
    CatalogQuantityHandoffReadySchema,
    CatalogQuantityHandoffReadySchema,
  ]),
  type: Schema.Literal('ready'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogFailureSchema = Schema.Struct({
  reasonCode: Schema.Literals(['RECEIVING_RELEASE_NOT_APPROVED', 'FIXTURE_UNAVAILABLE']),
  stage: Schema.String,
  type: Schema.Literal('failed'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const WholeCandidateCatalogResponseSchema = Schema.Union([
  WholeCandidateCatalogFailureSchema,
  WholeCandidateCatalogProducedSchema,
  WholeCandidateCatalogReadySchema,
  Schema.Struct({
    ruleRevision: Schema.Int,
    type: Schema.Literal('revised'),
    version: Schema.Literal(protocolVersion),
  }),
]);

const WholeCandidateCatalogDescriptionSchema = Schema.Struct({
  actionKeys: Schema.Array(Schema.String.pipe(Schema.brand('ActionKey'))),
  appId: Schema.Literal('catalog'),
  buildMarker: Schema.String,
  type: Schema.Literal('description'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const makeRegisteredBulkFixture = Effect.fn('BulkOriginalIntent.makeRegisteredFixture')(
  function* makeRegisteredBulkFixture() {
    const fs = yield* FileSystem.FileSystem;
    const appRoot = new URL('../../../../', import.meta.url).pathname;
    const directory = `${appRoot}verticals/catalog/.cache/ontos-1278/`;
    yield* fs.makeDirectory(directory, { recursive: true });
    const artifact = `${directory}${yield* nextId}.mjs`;
    yield* Effect.addFinalizer(() => fs.remove(artifact, { force: true }).pipe(Effect.orDie));
    const build = yield* ChildProcess.make(
      'mise',
      [
        'exec',
        '--',
        'pnpm',
        'exec',
        'esbuild',
        'verticals/catalog/tests/support/whole-candidate-catalog-receiver.fixture.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--outfile=${artifact}`,
      ],
      { cwd: appRoot, stderr: 'pipe', stdout: 'pipe' },
    );
    const [buildExit] = yield* Effect.all(
      [build.exitCode, Stream.runDrain(build.stdout), Stream.runDrain(build.stderr)],
      { concurrency: 3 },
    );
    expect(Number(buildExit)).toBe(0);
    const describe = yield* ChildProcess.make(process.execPath, [artifact, '--describe-whole-candidate'], {
      cwd: appRoot,
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    const [describeExit, described] = yield* Effect.all(
      [
        describe.exitCode,
        describe.stdout.pipe(Stream.decodeText(), Stream.runCollect),
        Stream.runDrain(describe.stderr),
      ],
      { concurrency: 3 },
    );
    expect(Number(describeExit)).toBe(0);
    const description = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(WholeCandidateCatalogDescriptionSchema),
    )(described.join('').trim());
    // Obtain each owner's actual marker separately; never assume Catalog == Pricing.
    const catalogComposition = yield* makeApplicationCompositionSnapshotFixture(['catalog'], description.buildMarker);
    const pricingComposition = yield* makeApplicationCompositionSnapshotFixture(
      ['pricing'],
      ultramodernApiMarker.buildMarker,
    );
    const combined = {
      ...pricingComposition.composition,
      modules: [...catalogComposition.composition.modules, ...pricingComposition.composition.modules],
      revision: '0'.repeat(64),
    };
    const digest = yield* Effect.tryPromise({
      catch: () => bulkInfrastructureUnavailable('composition-digest'),
      try: () =>
        globalThis.crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(canonicalizeApplicationComposition(combined)),
        ),
    });
    const composition = yield* validateActiveApplicationCompositionSnapshot({
      composition: { ...combined, revision: Buffer.from(digest).toString('hex') },
      observedAt: pricingComposition.observedAt,
      validUntil: pricingComposition.validUntil,
    });
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: composition,
      mode: 'schema-only',
      purpose: 'stabilization-1278-bulk-intent',
    });
    yield* isolated.assertClonedSchema();
    yield* copyOwnerBookkeeping(isolated.connections);
    yield* migrateOwner(isolated.connections);
    yield* verifyAppendOnlyPolicyRoleSets(isolated.connections.runtime);
    yield* migrateOwner(isolated.connections, 'verify');
    const evidenceServices = yield* Layer.build(
      PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
        Layer.provideMerge(Reactivity.layer),
      ),
    );
    const evidenceDatabase = yield* testCoreDatabase.pipe(Effect.provideContext(evidenceServices));
    const fixture = yield* Effect.acquireRelease(
      makeLiveOperationFixture({
        actionExecutor: 'manager-only',
        actionKeys: [
          ...description.actionKeys,
          Schema.String.pipe(Schema.brand('ActionKey')).make('commerce.pricing.manage-product-prices-bulk'),
          Schema.String.pipe(Schema.brand('ActionKey')).make('commerce.pricing.manage-product-commercial-fees-bulk'),
        ],
        adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
        allowedAudiences: ['catalog', 'pricing'],
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        compositionRevision: composition.composition.revision,
        moduleAccess: 'configured-modules',
        moduleKeys: ['commerce.catalog', 'commerce.pricing'],
        runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
      }),
      (value) => value.close().pipe(Effect.orDie),
    );
    const actor = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      ...fixture.manager,
      legalEntityId: fixture.legalEntityId,
    });
    const permissions = yield* makeContextPermissionRelationshipMutationLive();
    const principal = { principalId: fixture.manager.principalId, tenantId: fixture.tenantId };
    // Only fixed native-fixture contexts. Tenant Catalog reads and LE reads are distinct grants.
    for (const target of [
      { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.product-variant-snapshot' },
      { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.selection-evidence' },
    ]) {
      const grant = { operation: 'grant' as const, principal, target, tenantId: fixture.tenantId };
      yield* Effect.addFinalizer(() => permissions.mutate({ ...grant, operation: 'revoke' }).pipe(Effect.orDie));
      yield* permissions.mutate(grant);
    }
    for (const target of [
      { moduleId: 'commerce.pricing', permission: 'pricing.price.read' },
      { moduleId: 'commerce.pricing', permission: 'pricing.commercial_fee.read' },
      { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.quantity-preparation' },
    ]) {
      const grant = {
        legalEntityId: fixture.legalEntityId,
        operation: 'grant' as const,
        principal,
        target,
        tenantId: fixture.tenantId,
      };
      yield* Effect.addFinalizer(() => permissions.mutate({ ...grant, operation: 'revoke' }).pipe(Effect.orDie));
      yield* permissions.mutate(grant);
    }
    const signing = yield* makeBulkTestSigningAuthority(yield* Clock.Clock);
    const commands = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const responses = yield* Queue.unbounded<typeof WholeCandidateCatalogResponseSchema.Type>();
    const protocolFailure = yield* Deferred.make<never, BulkOriginalIntentInfrastructureUnavailable>();
    const child = yield* ChildProcess.make(process.execPath, [artifact, '--serve-whole-candidate'], {
      additionalFds: { fd3: { type: 'output' }, fd4: { stream: Stream.fromQueue(commands), type: 'input' } },
      cwd: appRoot,
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    yield* Effect.addFinalizer(() => Queue.end(commands));
    yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
    yield* Stream.runDrain(child.stdout).pipe(Effect.forkScoped);
    yield* child.getOutputFd(3).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.length > 0),
      Stream.mapEffect((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(WholeCandidateCatalogResponseSchema), {
          onExcessProperty: 'error',
        })(line),
      ),
      Stream.runForEach((response) => Queue.offer(responses, response)),
      Effect.catchCause(() => Deferred.fail(protocolFailure, bulkInfrastructureUnavailable('child-protocol'))),
      Effect.forkScoped,
    );
    const send = (command: typeof WholeCandidateCatalogCommandSchema.Type) =>
      Schema.encodeEffect(Schema.fromJsonString(WholeCandidateCatalogCommandSchema))(command).pipe(
        Effect.flatMap((line) => Queue.offer(commands, new TextEncoder().encode(`${line}\n`))),
      );
    const receive = () =>
      Effect.raceFirst(
        Effect.raceFirst(Queue.take(responses), Deferred.await(protocolFailure)),
        child.exitCode.pipe(Effect.flatMap(() => Effect.fail(bulkInfrastructureUnavailable('child-protocol')))),
      ).pipe(
        Effect.flatMap((response) => (response.type === 'failed' ? Effect.fail(response) : Effect.succeed(response))),
      );
    yield* send({
      actor: fixture.manager,
      composition,
      databaseName: isolated.connections.runtime.database,
      issuer: signing.issuer,
      jwks: signing.jwks,
      legalEntityId: WholeCandidateCatalogProducedSchema.fields.legalEntityId.make(fixture.legalEntityId),
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
      type: 'bootstrap',
      version,
    });
    const produced = yield* Schema.decodeUnknownEffect(WholeCandidateCatalogProducedSchema)(yield* receive());
    expect(produced.actor).toEqual(fixture.manager);
    expect(produced.buildMarker).toBe(description.buildMarker);
    expect(produced.compositionRevision).toBe(composition.composition.revision);
    const endpoint = {
      baseUrl: new URL(`http://127.0.0.1:${produced.port}`),
      compositionRevision: produced.compositionRevision,
    };
    const issueAuthorization = () =>
      signing.issue({
        actor: fixture.manager,
        audience: 'catalog',
        buildMarker: produced.buildMarker,
        compositionRevision: composition.composition.revision,
      });
    // Complete the Catalog child's existing producer-to-prepare protocol with exact TEST-owned grants.
    for (const resource of [produced.selections[0].productRef, produced.selections[2].productRef]) {
      yield* fixture.grantResourceAccess(resource, fixture.manager.principalId, 'reader');
      yield* Effect.addFinalizer(() =>
        fixture.revokeResourceAccess(resource, fixture.manager.principalId, 'reader').pipe(Effect.orDie),
      );
    }
    const issuePreparationAuthorization = () =>
      signing.issue({
        actor,
        audience: 'catalog',
        buildMarker: produced.buildMarker,
        compositionRevision: composition.composition.revision,
      });
    yield* send({
      authorizations: [
        Redacted.make(yield* issuePreparationAuthorization()),
        Redacted.make(yield* issuePreparationAuthorization()),
        Redacted.make(yield* issuePreparationAuthorization()),
      ],
      type: 'prepare',
      version,
    });
    const ready = yield* Schema.decodeUnknownEffect(WholeCandidateCatalogReadySchema)(yield* receive());
    expect(ready).toMatchObject({ ...produced, type: 'ready' });
    expect(ready.handoffs.map((handoff) => handoff.status)).toEqual(['READY', 'READY', 'READY']);
    expect(ready.handoffs.map((handoff) => handoff.selection)).toEqual(produced.selections);
    const runtimeInput = {
      actor,
      catalog: { ...endpoint, actor: fixture.manager, buildMarker: produced.buildMarker },
      composition,
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
      signing,
    };
    const http = yield* makeRegisteredBulkHttp(runtimeInput);
    const { context } = http;
    return {
      actor,
      callFee: http.fee,
      callPrice: http.price,
      catalog: {
        endpoint,
        issueAuthorization,
        produced,
        receive,
        send,
        stop: () =>
          send({ type: 'stop', version }).pipe(Effect.andThen(Queue.end(commands)), Effect.andThen(child.exitCode)),
      },
      composition,
      context,
      // Public observer: actual durable rows on this same owned tenant/database.
      evidence: () => fixture.evidence(evidenceDatabase),
      fixture,
      isolated,
      issuePricingAuthorization: http.issuePricing,
      pricingEndpoint: {
        baseUrl: http.baseUrl,
        compositionRevision: composition.composition.revision,
      },
      signing,
    };
  },
);

const registeredSourceAssertion = Effect.fn('BulkOriginalIntent.registeredSourceAssertion')(
  function* registeredSourceAssertion(
    key: typeof PriceIdentityKeySchema.Type,
    priceId: string,
    amount: string,
    effectiveAt: string,
    recordedAt: string,
    predecessor?: string,
  ) {
    return yield* Schema.decodeEffect(PriceSourceAssertionInputSchema)({
      lineage:
        predecessor === undefined
          ? { kind: 'INITIAL' }
          : {
              kind: 'SUPERSESSION',
              reason: 'Registered native schedule',
              supersededSourceAssertionId: predecessor,
            },
      mapping: { mappingContractRef: 'TEST:1278:exact-native-source', mappingContractVersion: '1' },
      originalAssertion: {
        monetaryAmount: { amount, currencyCode: 'CZK' },
        monetaryBoundary: 'PRE_TAX',
        unitBasis: key.unitBasis,
      },
      sourceAssertionId: yield* nextId,
      sourceAuthority: { sourceAuthorityRef: 'TEST:1278:owned-native-grant', sourceAuthorityVersion: '1' },
      sourceRecord: {
        sourceChangeCorrelation: yield* nextId,
        sourceRecordRef: priceId,
        sourceRecordVersion: effectiveAt,
        sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'TEST:1278:owned-native-source' },
      },
      timing: { importedAt: recordedAt, ownerBusinessEffectiveAt: effectiveAt, sourceEffectiveAt: effectiveAt },
    });
  },
);

const registeredPriceOriginalIntentTest = Effect.fnUntraced(function* registeredPriceOriginalIntent() {
  const nativeClock = yield* Clock.Clock;
  const registered = yield* makeRegisteredBulkFixture();
  const { catalog, fixture } = registered;
  const [firstSelection] = catalog.produced.selections;
  const [unitRef] = catalog.produced.units;
  const snapshot = yield* executeProductVariantSnapshotWithAuthorization(
    { productRef: firstSelection.productRef },
    yield* catalog.issueAuthorization(),
    yield* nextId,
    { baseUrl: catalog.endpoint.baseUrl, compositionRevision: registered.composition.composition.revision },
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PriceProductTargetSnapshotSchema)));
  expect(snapshot.targets).toHaveLength(2);
  const now = DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis);
  const recordedAt = DateTime.formatIso(now);
  const initialFrom = DateTime.formatIso(DateTime.add(now, { seconds: -1 }));
  const scheduledFrom = DateTime.formatIso(DateTime.add(now, { minutes: 10 }));
  const prepared = yield* fixture
    .prepareOwner(
      Effect.fn('BulkOriginalIntent.prepareRegisteredPrices')(function* prepareRegisteredPrices(transaction, scope) {
        const { legalEntityId } = scope;
        if (legalEntityId === undefined) {
          return yield* Effect.die('Registered Price precursor requires its resolved Selling Legal Entity');
        }
        const currency = yield* currencySupportPersistenceForScope(
          transaction,
          scope,
          registered.composition.composition.revision,
        );
        expect(
          yield* currency.setCurrent({
            ...(yield* Schema.decodeEffect(SetSupportedCurrenciesV2PayloadSchema)({
              expectedState: { state: 'ABSENT' },
              intendedEffectivePeriod: { effectiveFrom: initialFrom, effectiveTo: null },
              intent: 'ESTABLISH_CURRENT',
              reason: 'TEST isolated registered bulk currency',
              schemaVersion: '2',
              supportedCurrencies: ['CZK'],
            })),
            actingPrincipalId: scope.principalId,
            actionInvocationId: yield* nextId,
            tenantId: scope.tenantId,
            trustedOperationAt: DateTime.toDateUtc(now),
          }),
        ).toMatchObject({ outcome: 'CREATED' });
        const prices = yield* pricePersistenceForScope(transaction, scope);
        const authority = yield* externalPriceSourceAuthorityForScope(transaction, scope);
        const boundaryFactory = yield* ExternalPriceInputBoundaryFactory;
        return yield* Effect.forEach(
          snapshot.targets,
          (target) =>
            Effect.gen(function* prepareExactTarget() {
              const key = yield* Schema.decodeEffect(PriceIdentityKeySchema)({
                catalogSelection: target.target,
                commercialScope: {
                  channelId: 'B2C',
                  marketId: 'TEST:1278',
                  sellingLegalEntityId: legalEntityId,
                },
                currencyCode: 'CZK',
                priceGroupSelector: { kind: 'NO_GROUP' },
                unitBasis: { quantity: '1', unitRef },
              });
              const priceId = yield* nextId;
              const priceRef = {
                moduleId: 'commerce.pricing' as const,
                resourceId: priceId,
                resourceType: 'commerce.pricing.price' as const,
                tenantId: scope.tenantId,
              };
              const firstAssertion = yield* registeredSourceAssertion(key, priceId, '100', initialFrom, recordedAt);
              const grant = yield* Schema.decodeEffect(ExternalPriceSourceAuthorityGrantSchema)({
                authority: firstAssertion.sourceAuthority,
                effectivePeriod: { effectiveFrom: initialFrom },
                exactIdentityKey: key,
                family: 'PRICE',
                mapping: firstAssertion.mapping,
                ownerModuleId: 'commerce.pricing',
                schemaVersion: '1',
                verificationRef: `TEST:1278:owned-grant:${priceId}`,
                verifiedAt: recordedAt,
              });
              expect(yield* authority.store(grant)).toMatchObject({ outcome: 'STORED' });
              const source = yield* boundaryFactory.make(authority).assess({
                actingPrincipalId: scope.principalId,
                effectiveFrom: initialFrom,
                identityKey: key,
                monetaryAmount: { amount: '100', currencyCode: 'CZK' },
                sourceAssertion: firstAssertion,
                tenantId: scope.tenantId,
                trustedOperationAt: DateTime.toDateUtc(now),
              });
              if (source.outcome !== 'READY_FOR_CANONICAL_WRITE') {
                return yield* Effect.die('The real exact stored source grant must admit the native precursor');
              }
              expect(
                yield* prices.define({
                  actingPrincipalId: scope.principalId,
                  actionInvocationId: yield* nextId,
                  effectiveFrom: initialFrom,
                  identityKey: key,
                  monetaryAmount: { amount: '100', currencyCode: 'CZK' },
                  priceRef,
                  reason: 'TEST isolated owner-native DEFINE before registered bulk',
                  requestCorrelationId: yield* nextId,
                  sourceEvidence: source.evidence,
                  trustedOperationAt: DateTime.toDateUtc(now),
                }),
              ).toMatchObject({ outcome: 'CREATED' });
              const before = yield* prices.readSchedule(priceRef, DateTime.toDateUtc(now));
              if (before.outcome !== 'PRICE_SCHEDULE_CURRENT') {
                return yield* Effect.die('The supported native precursor must have its real schedule');
              }
              const canonicalKey = before.schedule.current?.definition.identityKey;
              if (canonicalKey === undefined) {
                return yield* Effect.die('The supported precursor must expose its canonical native Price identity');
              }
              expect(
                yield* authority.store({
                  ...grant,
                  exactIdentityKey: canonicalKey,
                  verificationRef: `TEST:1278:canonical-owned-grant:${priceId}`,
                }),
              ).toMatchObject({ outcome: 'STORED' });
              const sourceAssertion = yield* registeredSourceAssertion(
                canonicalKey,
                priceId,
                '90',
                scheduledFrom,
                recordedAt,
                firstAssertion.sourceAssertionId,
              );
              return {
                identity: {
                  snapshotId: snapshot.snapshotId,
                  target: target.target,
                  targetId: target.targetId,
                },
                intentId: `TEST:1278:registered-price:${yield* nextId}`,
                operation: {
                  kind: 'REVISE_PRICE' as const,
                  payload: {
                    effectivePeriod: { effectiveFrom: scheduledFrom, effectiveTo: null },
                    expectedScheduleRevision: before.schedule.scheduleRevision,
                    intent: 'SCHEDULE_REVISION' as const,
                    monetaryAmount: { amount: '90', currencyCode: 'CZK' },
                    priceRef,
                    reason: 'Exact registered original Price schedule',
                    sourceAssertion,
                  },
                },
                targetCorrelationRef: `TEST:1278:target:${target.targetId}`,
              };
            }),
          { concurrency: 1 },
        );
      }),
      'required',
    )
    .pipe(Effect.provideContext(registered.context));
  const input = yield* Schema.decodeUnknownEffect(ManageProductPricesBulkPayloadSchema)({
    snapshot,
    targetIntents: prepared,
  });
  const k1 = yield* nextId;
  // The real generated client settles K1. Discard its result to model lost caller observation.
  yield* registered.callPrice(input, k1).pipe(Effect.asVoid);
  const evidenceK1 = yield* registered.evidence();
  const invocationK1 = evidenceK1.invocations.find((row) => row.idempotencyKey === k1);
  expect(invocationK1?.status).toBe('succeeded');
  const auditK1 = evidenceK1.audits.filter(
    (row) => row.actionInvocationId === invocationK1?.actionInvocationId && row.eventType === 'action.executed',
  );
  expect(auditK1).toHaveLength(1);
  expect(auditK1[0]?.evidenceJson).toMatchObject({
    applied: snapshot.targets.length,
    conflicts: 0,
    targetCount: snapshot.targets.length,
  });
  const observe = () =>
    fixture.prepareOwner(
      Effect.fn('BulkOriginalIntent.observeRegisteredPrices')(function* observeRegisteredPrices(transaction, scope) {
        const prices = yield* pricePersistenceForScope(transaction, scope);
        return yield* Effect.forEach(
          prepared,
          Effect.fn(function* observeOne(target: (typeof prepared)[number]) {
            const actionInvocationId = productPriceBulkActionInvocationIdFor(scope.tenantId, target.intentId);
            const observation = DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis);
            const actual = yield* prices.readSchedule(
              target.operation.payload.priceRef,
              DateTime.toDateUtc(observation),
            );
            if (actual.outcome !== 'PRICE_SCHEDULE_CURRENT') {
              return yield* Effect.die('The owner must retain its genuine Current Price schedule');
            }
            expect(actual.schedule.observedAt).toBe(DateTime.formatIso(observation));
            // Observation time advances; retain every immutable schedule field and actual Current/future selection.
            return {
              receipt: yield* prices.lookupResult({ actionInvocationId }),
              schedule: {
                outcome: actual.outcome,
                schedule: {
                  current: actual.schedule.current,
                  future: actual.schedule.future,
                  priceRef: actual.schedule.priceRef,
                  revisions: actual.schedule.revisions,
                  scheduleRevision: actual.schedule.scheduleRevision,
                },
              },
            };
          }),
          { concurrency: 1 },
        );
      }),
      'required',
    );
  const committed = yield* observe();
  const k2 = yield* nextId;
  const recovered = yield* registered.callPrice(input, k2);
  expect(recovered.outcomes.map((row) => row.outcome)).toEqual(snapshot.targets.map(() => 'APPLIED'));
  expect(recovered.outcomes.map((row) => row.resolvedBy)).toEqual(snapshot.targets.map(() => 'OWNER_RECONCILIATION'));
  const verifyCanonicalReceipts = Effect.fn('BulkOriginalIntent.verifyPriceCanonicalReceipts')(
    function* verifyPriceCanonicalReceipts(
      targets: typeof input.targetIntents,
      results: readonly (typeof recovered)[],
    ) {
      const receipts = yield* fixture.prepareOwner(
        Effect.fn('BulkOriginalIntent.lookupExactPriceReceipts')(
          function* lookupExactPriceReceipts(transaction, scope) {
            const prices = yield* pricePersistenceForScope(transaction, scope);
            return yield* Effect.forEach(
              targets,
              (target) =>
                prices.lookupResult({
                  actionInvocationId: productPriceBulkActionInvocationIdFor(scope.tenantId, target.intentId),
                }),
              { concurrency: 1 },
            );
          },
        ),
        'required',
      );
      for (const result of results) {
        expect(result.outcomes.map((row) => row.identity.targetId).toSorted()).toEqual(
          targets.map((target) => target.identity.targetId).toSorted(),
        );
        for (const [index, target] of targets.entries()) {
          const receipt = receipts[index];
          if (receipt?.outcome !== 'PRICE_ACTION_RESULT_FOUND' || receipt.result.outcome !== 'REVISED') {
            return yield* Effect.die('Every settled schedule intent must retain its actual revised owner receipt');
          }
          const matching = result.outcomes.filter(
            (row) => row.identity.targetId === target.identity.targetId && row.intentId === target.intentId,
          );
          expect(matching).toHaveLength(1);
          expect(matching[0]).toMatchObject({
            canonical: {
              priceRef: receipt.result.revision.definition.priceRef,
              revisionId: receipt.result.revision.definition.revision.revisionId,
            },
            outcome: 'APPLIED',
          });
        }
      }
      return yield* Effect.void;
    },
  );
  yield* verifyCanonicalReceipts(input.targetIntents, [recovered]);
  for (const outcome of recovered.outcomes) {
    expect(outcome).not.toHaveProperty('originalIntentMatches');
    expect(outcome).not.toHaveProperty('requestPayload');
    expect(outcome).not.toHaveProperty('sourceEvidence');
  }
  expect(yield* observe()).toEqual(committed);
  const conflictedKeys: string[] = [];
  for (const targetIntents of [
    prepared.map((target) => ({
      ...target,
      operation: {
        ...target.operation,
        payload: {
          ...target.operation.payload,
          effectivePeriod: {
            effectiveFrom: DateTime.formatIso(DateTime.add(now, { minutes: 11 })),
            effectiveTo: null,
          },
        },
      },
    })),
    prepared.map((target) => ({
      ...target,
      operation: {
        ...target.operation,
        payload: {
          ...target.operation.payload,
          effectivePeriod: {
            effectiveFrom: scheduledFrom,
            effectiveTo: DateTime.formatIso(DateTime.add(now, { minutes: 30 })),
          },
        },
      },
    })),
    prepared.map((target) => ({
      ...target,
      operation: {
        ...target.operation,
        payload: {
          ...target.operation.payload,
          expectedScheduleRevision: target.operation.payload.expectedScheduleRevision + 1,
        },
      },
    })),
    prepared.map((target) => ({
      ...target,
      operation: {
        ...target.operation,
        payload: { ...target.operation.payload, reason: 'Changed canonical reason' },
      },
    })),
    prepared.map((target) => ({
      ...target,
      operation: {
        ...target.operation,
        payload: {
          ...target.operation.payload,
          sourceAssertion: {
            ...target.operation.payload.sourceAssertion,
            mapping: { ...target.operation.payload.sourceAssertion.mapping, mappingContractVersion: '2' },
          },
        },
      },
    })),
  ]) {
    const changed = yield* Schema.decodeUnknownEffect(ManageProductPricesBulkPayloadSchema)({
      ...input,
      targetIntents,
    });
    const changedKey = yield* nextId;
    conflictedKeys.push(changedKey);
    const result = yield* registered.callPrice(changed, changedKey);
    expect(result.outcomes.map((row) => row.outcome)).toEqual(snapshot.targets.map(() => 'CONFLICT'));
    expect(result.outcomes.map((row) => (row.outcome === 'CONFLICT' ? row.reasonCode : ''))).toEqual(
      snapshot.targets.map(() => 'IDEMPOTENCY_CONFLICT'),
    );
    expect(yield* observe()).toEqual(committed);
    const sameKeyFailure = yield* registered.callPrice(changed, k1).pipe(Effect.flip);
    expect(
      yield* Schema.decodeUnknownEffect(ManageProductPricesBulkActionConflictProblemSchema)(sameKeyFailure),
    ).toMatchObject({ code: 'action_request_hash_conflict', status: 409 });
  }
  const retireTargets = yield* Effect.forEach(
    prepared,
    (target, index) =>
      Effect.gen(function* priceRetirementIntent() {
        const state = committed[index];
        if (state?.schedule.outcome !== 'PRICE_SCHEDULE_CURRENT' || state.schedule.schedule.current === undefined) {
          return yield* Effect.die('The retirement intent requires the real Current Price basis');
        }
        const { current } = state.schedule.schedule;
        return {
          ...target,
          operation: {
            kind: 'REVISE_PRICE',
            payload: {
              expectedCurrent: {
                effectivePeriod: current.effectivePeriod,
                priceRef: target.operation.payload.priceRef,
                revision: current.definition.revision.revision,
                revisionId: current.definition.revision.revisionId,
                scheduleRevision: state.schedule.schedule.scheduleRevision,
              },
              intent: 'RETIRE_CURRENT',
              priceRef: target.operation.payload.priceRef,
              reason: 'Changed operation under original schedule intent',
            },
          },
        };
      }),
    { concurrency: 1 },
  );
  const retirement = yield* Schema.decodeUnknownEffect(ManageProductPricesBulkPayloadSchema)({
    ...input,
    targetIntents: retireTargets,
  });
  const retirementKey = yield* nextId;
  const retireConflict = yield* registered.callPrice(retirement, retirementKey);
  expect(retireConflict.outcomes.map((row) => row.outcome)).toEqual(snapshot.targets.map(() => 'CONFLICT'));
  expect(retireConflict.outcomes.map((row) => (row.outcome === 'CONFLICT' ? row.reasonCode : ''))).toEqual(
    snapshot.targets.map(() => 'IDEMPOTENCY_CONFLICT'),
  );
  expect(yield* observe()).toEqual(committed);
  const intentEvidence = yield* registered.evidence();
  const expectIntentAudit = (key: string) => {
    const invocations = intentEvidence.invocations.filter((row) => row.idempotencyKey === key);
    expect(invocations).toHaveLength(1);
    const [invocation] = invocations;
    expect(invocation?.status).toBe('succeeded');
    const audits = intentEvidence.audits.filter(
      (row) => row.actionInvocationId === invocation?.actionInvocationId && row.eventType === 'action.executed',
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.evidenceJson).toMatchObject({
      applied: key === k2 ? 2 : 0,
      conflicts: key === k2 ? 0 : 2,
      targetCount: 2,
    });
  };
  for (const key of [k2, ...conflictedKeys, retirementKey]) {
    expectIntentAudit(key);
  }
  const callAuthorized = (authorization: string, key: string) =>
    nextId.pipe(
      Effect.flatMap((correlation) =>
        executeManageProductPricesBulkWithAuthorization(input, authorization, correlation, {
          baseUrl: registered.pricingEndpoint.baseUrl,
          compositionRevision: registered.composition.composition.revision,
          idempotencyKey: key,
        }),
      ),
    );
  const repeated = yield* registered.issuePricingAuthorization();
  yield* callAuthorized(repeated, yield* nextId);
  const reused = yield* callAuthorized(repeated, yield* nextId).pipe(Effect.flip);
  expect(
    yield* Schema.decodeUnknownEffect(ManageProductPricesBulkActionAuthenticationProblemSchema)(reused),
  ).toMatchObject({ status: 401 });
  const expired = yield* registered.signing.issue({
    actor: registered.actor,
    audience: 'pricing',
    buildMarker: ultramodernApiMarker.buildMarker,
    compositionRevision: registered.composition.composition.revision,
    issuedAt: DateTime.add(DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis), {
      seconds: -(GATEWAY_ASSERTION_TTL_SECONDS + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS + 2),
    }),
  });
  expect(
    yield* Schema.decodeUnknownEffect(ManageProductPricesBulkActionAuthenticationProblemSchema)(
      yield* callAuthorized(expired, yield* nextId).pipe(Effect.flip),
    ),
  ).toMatchObject({ status: 401 });
  const wrongAudience = yield* registered.signing.issue({
    actor: fixture.manager,
    audience: 'catalog',
    buildMarker: catalog.produced.buildMarker,
    compositionRevision: registered.composition.composition.revision,
  });
  expect(
    yield* Schema.decodeUnknownEffect(ManageProductPricesBulkActionAuthenticationProblemSchema)(
      yield* callAuthorized(wrongAudience, yield* nextId).pipe(Effect.flip),
    ),
  ).toMatchObject({ status: 401 });
  const contextDenied = yield* registered.issuePricingAuthorization({
    ...fixture.denied,
    legalEntityId: fixture.legalEntityId,
  });
  expect(
    yield* Schema.decodeUnknownEffect(ManageProductPricesBulkActionForbiddenProblemSchema)(
      yield* callAuthorized(contextDenied, yield* nextId).pipe(Effect.flip),
    ),
  ).toMatchObject({ code: 'operation_context_denied', status: 403 });
  const denied = yield* registered.issuePricingAuthorization({
    ...fixture.legalEntityOnly,
    legalEntityId: fixture.legalEntityId,
  });
  expect(
    yield* Schema.decodeUnknownEffect(ManageProductPricesBulkActionForbiddenProblemSchema)(
      yield* callAuthorized(denied, yield* nextId).pipe(Effect.flip),
    ),
  ).toMatchObject({ code: 'action_permission_denied', status: 403 });
  expect(yield* observe()).toEqual(committed);
  // Observe the actual encoded HTTP body as well as the generated client's decoded projection.
  const wirePayload = yield* Schema.encodeEffect(ManageProductPricesBulkPayloadSchema)(input);
  const wireAuthorization = yield* registered.issuePricingAuthorization();
  const wireRequest = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(new URL('/pricing/actions/manage-product-prices-bulk', registered.pricingEndpoint.baseUrl)),
    wirePayload,
  );
  const httpClient = yield* HttpClient.HttpClient;
  const wireResponse = yield* httpClient.execute(
    wireRequest.pipe(
      HttpClientRequest.setHeaders({
        authorization: wireAuthorization,
        'idempotency-key': yield* nextId,
        'x-correlation-id': yield* nextId,
        'x-ontos-composition-revision': registered.composition.composition.revision,
      }),
    ),
  );
  expect(wireResponse.status).toBe(200);
  const wire = yield* wireResponse.text;
  expect(wire).not.toContain('"originalIntentMatches"');
  expect(wire).not.toContain('"requestPayload"');
  expect(wire).not.toContain('"sourceEvidence"');
  expect(yield* observe()).toEqual(committed);
  const followup = (previous: typeof input, minutes: number) =>
    fixture.prepareOwner(
      Effect.fn('BulkOriginalIntent.followupIntent')(function* followupIntent(transaction, scope) {
        const prices = yield* pricePersistenceForScope(transaction, scope);
        const targetIntents = yield* Effect.forEach(
          previous.targetIntents,
          Effect.fn(function* nextTargetIntent(target: (typeof previous.targetIntents)[number]) {
            if (target.operation.kind !== 'REVISE_PRICE' || target.operation.payload.intent !== 'SCHEDULE_REVISION') {
              return yield* Effect.die('Followup requires the exact successful schedule producer');
            }
            const schedule = yield* prices.readSchedule(
              target.operation.payload.priceRef,
              DateTime.toDateUtc(DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis)),
            );
            if (schedule.outcome !== 'PRICE_SCHEDULE_CURRENT') {
              return yield* Effect.die('Followup requires actual owner schedule');
            }
            const [first] = schedule.schedule.revisions;
            if (first === undefined) {
              return yield* Effect.die('Owner schedule requires its original exact identity');
            }
            const at = DateTime.formatIso(DateTime.add(now, { minutes }));
            return {
              ...target,
              intentId: `TEST:1278:distinct:${yield* nextId}`,
              operation: {
                kind: 'REVISE_PRICE' as const,
                payload: {
                  ...target.operation.payload,
                  effectivePeriod: { effectiveFrom: at, effectiveTo: null },
                  expectedScheduleRevision: schedule.schedule.scheduleRevision,
                  sourceAssertion: yield* registeredSourceAssertion(
                    first.definition.identityKey,
                    target.operation.payload.priceRef.resourceId,
                    '90',
                    at,
                    DateTime.formatIso(DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis)),
                    target.operation.payload.sourceAssertion.sourceAssertionId,
                  ),
                },
              },
            };
          }),
          { concurrency: 1 },
        );
        return yield* Schema.decodeUnknownEffect(ManageProductPricesBulkPayloadSchema)({
          snapshot,
          targetIntents,
        });
      }),
      'required',
    );
  const raceInput = yield* followup(input, 20);
  const exactRaceKeyA = yield* nextId;
  const exactRaceKeyB = yield* nextId;
  const [exactRaceA, exactRaceB] = yield* Effect.all(
    [registered.callPrice(raceInput, exactRaceKeyA), registered.callPrice(raceInput, exactRaceKeyB)],
    { concurrency: 2 },
  );
  for (const result of [exactRaceA, exactRaceB]) {
    expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual(snapshot.targets.map(() => 'APPLIED'));
  }
  yield* verifyCanonicalReceipts(raceInput.targetIntents, [exactRaceA, exactRaceB]);
  const afterExactRace = yield* observe();
  for (const [index, state] of afterExactRace.entries()) {
    const before = committed[index];
    if (state.schedule.outcome !== 'PRICE_SCHEDULE_CURRENT' || before?.schedule.outcome !== 'PRICE_SCHEDULE_CURRENT') {
      return yield* Effect.die('Separate transactions must retain actual owner schedules');
    }
    expect(state.schedule.schedule.revisions).toHaveLength(before.schedule.schedule.revisions.length + 1);
    expect(state.receipt).toEqual(before.receipt);
  }
  // A different per-target identity is not merged, but its stale CAS cannot manufacture another effect.
  const staleInput = yield* Schema.decodeUnknownEffect(ManageProductPricesBulkPayloadSchema)({
    ...raceInput,
    targetIntents: raceInput.targetIntents.map((target) => ({
      ...target,
      intentId: `TEST:1278:stale:${target.intentId}`,
    })),
  });
  const managed = yield* registered.callPrice(staleInput, yield* nextId);
  expect(managed.outcomes.map((outcome) => outcome.outcome)).toEqual(snapshot.targets.map(() => 'CONFLICT'));
  expect(managed.outcomes.map((outcome) => (outcome.outcome === 'CONFLICT' ? outcome.reasonCode : ''))).toEqual(
    snapshot.targets.map(() => 'SCHEDULE_REVISION_STALE'),
  );
  expect(yield* observe()).toEqual(afterExactRace);
  // The owner terminal-conflict receipt contract retains a settled stale-CAS result without a revision effect.
  const rejectedReceipts = yield* fixture.prepareOwner(
    Effect.fn('BulkOriginalIntent.verifyManagedRejection')(function* verifyManagedRejection(transaction, scope) {
      const prices = yield* pricePersistenceForScope(transaction, scope);
      return yield* Effect.forEach(
        staleInput.targetIntents,
        (target) =>
          prices.lookupOriginalResult({
            actionInvocationId: productPriceBulkActionInvocationIdFor(scope.tenantId, target.intentId),
            operation: target.operation,
          }),
        { concurrency: 1 },
      );
    }),
    'required',
  );
  for (const [index, target] of staleInput.targetIntents.entries()) {
    expect(rejectedReceipts[index]).toMatchObject({
      actionInvocationId: productPriceBulkActionInvocationIdFor(fixture.tenantId, target.intentId),
      originalIntentMatches: true,
      outcome: 'PRICE_ACTION_RESULT_FOUND',
      result: { outcome: 'CONFLICT', reason: 'SCHEDULE_REVISION_STALE' },
    });
  }
  const competing = yield* followup(raceInput, 30);
  const altered = yield* Schema.decodeUnknownEffect(ManageProductPricesBulkPayloadSchema)({
    ...competing,
    targetIntents: competing.targetIntents.map((target) => ({
      ...target,
      operation: {
        ...target.operation,
        payload: { ...target.operation.payload, reason: 'Competing changed canonical intent' },
      },
    })),
  });
  const competitors = yield* Effect.all(
    [registered.callPrice(competing, yield* nextId), registered.callPrice(altered, yield* nextId)],
    { concurrency: 2 },
  );
  for (const index of snapshot.targets.keys()) {
    expect(
      competitors
        .map((result) => result.outcomes[index]?.outcome)
        .toSorted((left, right) => (left ?? '').localeCompare(right ?? '')),
    ).toEqual(['APPLIED', 'CONFLICT']);
  }
  const winning = competitors[0].outcomes.every((outcome) => outcome.outcome === 'APPLIED') ? competing : altered;
  const beforeAbort = yield* observe();
  const abortInput = yield* followup(winning, 40);
  const [, blockedTarget] = abortInput.targetIntents;
  if (blockedTarget === undefined) {
    return yield* Effect.die('Rollback proof needs the actual second fixed target');
  }
  const holder = yield* PgClient.make({
    maxConnections: 1,
    url: Redacted.make(registered.isolated.connections.runtime.connectionString),
  });
  const monitor = yield* PgClient.make({
    maxConnections: 1,
    url: Redacted.make(registered.isolated.connections.admin.connectionString),
  });
  const holderReady = yield* Deferred.make<number>();
  const release = yield* Deferred.make<boolean>();
  yield* Effect.addFinalizer(() => Deferred.succeed(release, true));
  const holderFiber = yield* holder
    .withTransaction(
      Effect.gen(function* holdExactOwnerInvocation() {
        const [holderRow] = yield* holder.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid');
        if (holderRow === undefined) {
          return yield* Effect.die('Owned lock holder must identify its exact backend');
        }
        const { pid } = holderRow;
        const invocation = productPriceBulkActionInvocationIdFor(fixture.tenantId, blockedTarget.intentId);
        yield* holder.unsafe('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          `${fixture.tenantId}:pricing-action-result:${invocation}`,
        ]);
        yield* Deferred.succeed(holderReady, pid);
        yield* Deferred.await(release);
        return yield* Effect.void;
      }),
    )
    .pipe(Effect.forkScoped);
  const holderPid = yield* Deferred.await(holderReady);
  const abortKey = yield* nextId;
  const actionFiber = yield* registered.callPrice(abortInput, abortKey).pipe(Effect.flip, Effect.forkScoped);
  const findBlocked = Effect.gen(function* findOwnedBlockedBackend() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = yield* monitor.unsafe<{ readonly pid: number }>(
        `select activity.pid from pg_catalog.pg_stat_activity activity
           where activity.datid=(select oid from pg_catalog.pg_database where datname=$1)
             and activity.pid<>$2 and $2=any(pg_catalog.pg_blocking_pids(activity.pid))
             and activity.query like '%"pricing"."revise_price_v3"%'
             and activity.wait_event_type='Lock'`,
        [registered.isolated.connections.runtime.database, holderPid],
      );
      if (rows.length === 1 && rows[0] !== undefined) {
        return rows[0].pid;
      }
      if (rows.length > 1) {
        return yield* Effect.die('Never cancel an ambiguous owner backend');
      }
      yield* nativeClock.sleep(Duration.millis(100));
    }
    return yield* Effect.die('The bounded exact owner routine did not reach its expected lock');
  });
  const abortProof = Effect.gen(function* cancelOnlyOwnedBlockedRoutine() {
    const pid = yield* findBlocked;
    const rows = yield* monitor.unsafe<{ readonly cancelled: boolean }>(
      `select pg_catalog.pg_cancel_backend(activity.pid) as cancelled
         from pg_catalog.pg_stat_activity activity
         where activity.pid=$1
           and activity.datid=(select oid from pg_catalog.pg_database where datname=$2)
           and $3=any(pg_catalog.pg_blocking_pids(activity.pid))
           and activity.query like '%"pricing"."revise_price_v3"%'
           and activity.wait_event_type='Lock'`,
      [pid, registered.isolated.connections.runtime.database, holderPid],
    );
    expect(rows.length === 1 && rows[0]?.cancelled === true).toBe(true);
    const failure = yield* Fiber.join(actionFiber);
    expect(
      yield* Schema.decodeUnknownEffect(ManageProductPricesBulkActionUnavailableProblemSchema)(failure),
    ).toMatchObject({
      code: 'action_transaction_failed',
      status: 503,
    });
  }).pipe(Effect.ensuring(Deferred.succeed(release, true)));
  yield* abortProof;
  yield* Fiber.join(holderFiber);
  expect(yield* observe()).toEqual(beforeAbort);
  const abortedReceipts = yield* fixture.prepareOwner(
    Effect.fn('BulkOriginalIntent.verifyUncaughtAbort')(function* verifyUncaughtAbort(transaction, scope) {
      const prices = yield* pricePersistenceForScope(transaction, scope);
      return yield* Effect.forEach(
        abortInput.targetIntents,
        (target) =>
          prices.lookupOriginalResult({
            actionInvocationId: productPriceBulkActionInvocationIdFor(scope.tenantId, target.intentId),
            operation: target.operation,
          }),
        { concurrency: 1 },
      );
    }),
    'required',
  );
  expect(abortedReceipts).toEqual(
    abortInput.targetIntents.map((target) => ({
      actionInvocationId: productPriceBulkActionInvocationIdFor(fixture.tenantId, target.intentId),
      outcome: 'PRICE_ACTION_RESULT_ABSENT',
    })),
  );
  const finalEvidence = yield* registered.evidence();
  const abortedInvocations = finalEvidence.invocations.filter((row) => row.idempotencyKey === abortKey);
  expect(abortedInvocations).toHaveLength(1);
  const [failed] = abortedInvocations;
  if (failed === undefined) {
    return yield* Effect.die('The aborted public Action must retain exactly one durable invocation');
  }
  expect(failed).toMatchObject({ completedAt: null, status: 'received' });
  expect(
    finalEvidence.audits.filter(
      (row) =>
        row.actionInvocationId === failed.actionInvocationId &&
        row.eventType === 'action.executed' &&
        row.outcome === 'succeeded',
    ),
  ).toHaveLength(0);
  yield* catalog.stop();
  return yield* Effect.void;
}, Effect.scoped);

it.layer(nativeServices, { excludeTestServices: true })((suite) =>
  suite.effect(
    'settles registered public Price K1 and recovers only its exact K2 intent with truthful audit (#1278)',
    () =>
      registeredPriceOriginalIntentTest().pipe(
        Effect.provide(staffAuthenticationNamespaceRegistryLayer(['catalog', 'pricing'])),
      ),
    120_000,
  ),
);

const registeredFeeOriginalIntentTest = Effect.fnUntraced(function* registeredFeeOriginalIntent() {
  const nativeClock = yield* Clock.Clock;
  const registered = yield* makeRegisteredBulkFixture();
  const { catalog, fixture } = registered;
  // Genuine complete owner response, including both sibling Variants. No constructed snapshot witness.
  const snapshot = yield* executeProductVariantSnapshotWithAuthorization(
    { productRef: catalog.produced.selections[0].productRef },
    yield* catalog.issueAuthorization(),
    yield* nextId,
    catalog.endpoint,
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PricingCommercialFeeProductTargetSnapshotSchema)));
  expect(snapshot.targets).toHaveLength(2);
  // All process/server/migration setup has completed before starting this bounded real chronology.
  const t0 = DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis);
  const tB = DateTime.add(t0, { seconds: 15 });
  const tC = DateTime.add(t0, { seconds: 25 });
  const tD = DateTime.add(t0, { seconds: 95 });
  const initialFrom = DateTime.formatIso(DateTime.add(t0, { seconds: -1 }));
  const initialTo = DateTime.formatIso(tB);
  const scheduledFrom = DateTime.formatIso(tC);
  const scheduledTo = DateTime.formatIso(tD);
  expect(initialFrom < initialTo && initialTo < scheduledFrom && scheduledFrom < scheduledTo).toBe(true);
  const prepared = yield* fixture
    .prepareOwner(
      Effect.fn('BulkOriginalIntent.prepareRegisteredFees')(function* prepareRegisteredFees(transaction, scope) {
        const currency = yield* currencySupportPersistenceForScope(
          transaction,
          scope,
          registered.composition.composition.revision,
        );
        expect(
          yield* currency.setCurrent({
            ...(yield* Schema.decodeEffect(SetSupportedCurrenciesV2PayloadSchema)({
              expectedState: { state: 'ABSENT' },
              intendedEffectivePeriod: { effectiveFrom: initialFrom, effectiveTo: null },
              intent: 'ESTABLISH_CURRENT',
              reason: 'TEST isolated registered Fee currency',
              schemaVersion: '2',
              supportedCurrencies: ['CZK'],
            })),
            actingPrincipalId: scope.principalId,
            actionInvocationId: yield* nextId,
            tenantId: scope.tenantId,
            trustedOperationAt: DateTime.toDateUtc(t0),
          }),
        ).toMatchObject({ outcome: 'CREATED' });
        const fees = yield* commercialFeePersistenceForScope(transaction, scope);
        return yield* Effect.forEach(
          snapshot.targets,
          (target) =>
            Effect.gen(function* prepareFeeTarget() {
              const catalogTargetEvidence = {
                capturedAt: snapshot.capturedAt,
                catalogOwnerRevision: snapshot.catalogOwnerRevision,
                productRef: target.target.productRef,
                snapshotId: snapshot.snapshotId,
                targetId: target.targetId,
                variantRef: target.target.variantRef,
              };
              const defineOperation = yield* Schema.decodeUnknownEffect(ManageProductCommercialFeeOperationSchema)({
                kind: 'DEFINE_COMMERCIAL_FEE',
                payload: {
                  catalogTargetEvidence,
                  configuredAmount: { amount: '20', currencyCode: 'CZK' },
                  effectivePeriod: { effectiveFrom: initialFrom, effectiveTo: initialTo },
                  identityKey: {
                    calculationBasis: { kind: 'FIXED_PER_LINE' },
                    commercialScope: {
                      channelId: 'B2C',
                      marketId: 'TEST:1278',
                      sellingLegalEntityId: scope.legalEntityId,
                    },
                    currencyCode: 'CZK',
                    family: 'RECYCLING_FEE',
                    monetaryBoundary: 'PRE_TAX',
                    target: { variantRef: target.target.variantRef },
                  },
                  reason: 'TEST native finite initial Fee with genuine Catalog target',
                },
              });
              if (defineOperation.kind !== 'DEFINE_COMMERCIAL_FEE') {
                return yield* Effect.die('The supported Fee precursor must be DEFINE');
              }
              expect(
                yield* fees.define({
                  ...defineOperation.payload,
                  actingPrincipalId: scope.principalId,
                  actionInvocationId: yield* nextId,
                  requestCorrelationId: yield* nextId,
                  trustedOperationAt: DateTime.toDateUtc(t0),
                }),
              ).toMatchObject({ outcome: 'COMMERCIAL_FEE_CREATED' });
              const before = yield* fees.readSchedule({
                identityKey: defineOperation.payload.identityKey,
                trustedOperationAt: DateTime.toDateUtc(t0),
              });
              if (before.outcome !== 'COMMERCIAL_FEE_SCHEDULE' || before.schedule.current === undefined) {
                return yield* Effect.die('The native finite Fee must really be Current at t0');
              }
              expect(before.schedule.current.effectivePeriod).toEqual({
                effectiveFrom: initialFrom,
                effectiveTo: initialTo,
              });
              return {
                catalogTargetEvidence,
                identity: {
                  snapshotId: snapshot.snapshotId,
                  target: target.target,
                  targetId: target.targetId,
                },
                intentId: `TEST:1278:registered-fee:${yield* nextId}`,
                operation: {
                  kind: 'REVISE_COMMERCIAL_FEE' as const,
                  payload: {
                    catalogTargetEvidence,
                    configuredAmount: defineOperation.payload.configuredAmount,
                    effectivePeriod: { effectiveFrom: scheduledFrom, effectiveTo: scheduledTo },
                    expectedScheduleRevision: before.schedule.scheduleRevision,
                    identityKey: defineOperation.payload.identityKey,
                    intent: 'SCHEDULE_REVISION' as const,
                    reason: 'Exact registered nonoverlapping Fee schedule',
                  },
                },
                targetCorrelationRef: `TEST:1278:fee-target:${target.targetId}`,
              };
            }),
          { concurrency: 1 },
        );
      }),
      'required',
    )
    .pipe(Effect.provideContext(registered.context));
  const input = yield* Schema.decodeUnknownEffect(ManageProductCommercialFeesBulkPayloadSchema)({
    snapshot,
    targetIntents: prepared,
  });
  const k1 = yield* nextId;
  expect(DateTime.formatIso(DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis)) < scheduledFrom).toBe(true);
  // Model lost caller observation only after the genuine generated HTTP client has settled K1.
  yield* registered.callFee(input, k1).pipe(Effect.asVoid);
  expect(DateTime.formatIso(DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis)) < scheduledFrom).toBe(true);
  const k1Evidence = yield* registered.evidence();
  const k1Invocation = k1Evidence.invocations.find((row) => row.idempotencyKey === k1);
  expect(k1Invocation?.status).toBe('succeeded');
  const k1Audit = k1Evidence.audits.filter(
    (row) => row.actionInvocationId === k1Invocation?.actionInvocationId && row.eventType === 'action.executed',
  );
  expect(k1Audit).toHaveLength(1);
  expect(k1Audit[0]?.evidenceJson).toMatchObject({ conflicts: 0, retired: 0, scheduled: 2, targetCount: 2 });
  // Native Clock and real sleep; no mocked Current interval or injected business timestamp.
  const waitMillis =
    DateTime.toDateUtc(tC).getTime() +
    250 -
    DateTime.toDateUtc(DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis)).getTime();
  expect(waitMillis).toBeGreaterThan(0);
  yield* nativeClock.sleep(Duration.millis(waitMillis));
  const t2 = DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis);
  expect(scheduledFrom <= DateTime.formatIso(t2) && DateTime.formatIso(t2) < scheduledTo).toBe(true);
  const observe = (expectedRevisions = 2) =>
    fixture
      .prepareOwner(
        Effect.fn('BulkOriginalIntent.observeRegisteredFees')(function* observeRegisteredFees(transaction, scope) {
          const fees = yield* commercialFeePersistenceForScope(transaction, scope);
          return yield* Effect.forEach(
            prepared,
            Effect.fn(function* observeFeeTarget(target: (typeof prepared)[number]) {
              const receipt = yield* fees.lookupResult({
                actionInvocationId: productCommercialFeeBulkActionInvocationIdFor(scope.tenantId, target.intentId),
              });
              const result = yield* fees.readSchedule({
                identityKey: target.operation.payload.identityKey,
                trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis)),
              });
              if (result.outcome !== 'COMMERCIAL_FEE_SCHEDULE' || result.schedule.current === undefined) {
                return yield* Effect.die('The scheduled Fee must really be Current inside [tC,tD)');
              }
              expect(result.schedule.current.effectivePeriod).toEqual({
                effectiveFrom: scheduledFrom,
                effectiveTo: scheduledTo,
              });
              expect(result.schedule.revisions).toHaveLength(expectedRevisions);
              expect(receipt).toMatchObject({ outcome: 'COMMERCIAL_FEE_ACTION_RESULT_FOUND' });
              expect(receipt).not.toHaveProperty('originalIntentMatches');
              // Observation time changes lawfully; compare the complete immutable schedule and selected revision.
              return {
                current: result.schedule.current,
                feeRef: result.schedule.feeRef,
                receipt,
                revisions: result.schedule.revisions,
                scheduleRevision: result.schedule.scheduleRevision,
              };
            }),
            { concurrency: 1 },
          );
        }),
        'required',
      )
      .pipe(Effect.provideContext(registered.context));
  const committed = yield* observe();
  const k2 = yield* nextId;
  const recovered = yield* registered.callFee(input, k2);
  expect(recovered.outcomes.map((row) => row.outcome)).toEqual(['SCHEDULED', 'SCHEDULED']);
  expect(recovered.outcomes.map((row) => row.resolvedBy)).toEqual(['OWNER_RECONCILIATION', 'OWNER_RECONCILIATION']);
  for (const row of recovered.outcomes) {
    const targetIndex = prepared.findIndex((target) => target.identity.targetId === row.identity.targetId);
    const settled = committed[targetIndex];
    if (settled === undefined) {
      return yield* Effect.die('Recovered Fee target must belong to the exact complete fixed set');
    }
    expect(row).toMatchObject({
      canonical: {
        feeRef: settled.feeRef,
        revisionId: settled.current.definition.revision.revisionId,
      },
    });
    expect(row).not.toHaveProperty('originalIntentMatches');
    expect(row).not.toHaveProperty('requestPayload');
    expect(row).not.toHaveProperty('sourceEvidence');
  }
  expect(yield* observe()).toEqual(committed);
  const wirePayload = yield* Schema.encodeEffect(ManageProductCommercialFeesBulkPayloadSchema)(input);
  const wireAuthorization = yield* registered.issuePricingAuthorization();
  const wireRequest = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(
      new URL('/pricing/actions/manage-product-commercial-fees-bulk', registered.pricingEndpoint.baseUrl),
    ),
    wirePayload,
  );
  const httpClient = yield* HttpClient.HttpClient;
  const wireResponse = yield* httpClient.execute(
    wireRequest.pipe(
      HttpClientRequest.setHeaders({
        authorization: wireAuthorization,
        'idempotency-key': yield* nextId,
        'x-correlation-id': yield* nextId,
        'x-ontos-composition-revision': registered.composition.composition.revision,
      }),
    ),
  );
  expect(wireResponse.status).toBe(200);
  const wire = yield* wireResponse.text;
  expect(wire).not.toContain('"originalIntentMatches"');
  expect(wire).not.toContain('"requestPayload"');
  expect(wire).not.toContain('"sourceEvidence"');
  expect(yield* observe()).toEqual(committed);
  const retireAt = DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis), { seconds: 10 }),
  );
  expect(scheduledFrom < retireAt && retireAt < scheduledTo).toBe(true);
  const retirementTargets = yield* Effect.forEach(
    prepared,
    (target, index) =>
      Effect.gen(function* retirementTarget() {
        const settled = committed[index];
        if (settled === undefined) {
          return yield* Effect.die('Every fixed snapshot target needs its settled Current basis');
        }
        return {
          ...target,
          operation: {
            kind: 'REVISE_COMMERCIAL_FEE',
            payload: {
              effectiveTo: retireAt,
              expectedCurrent: {
                effectivePeriod: settled.current.effectivePeriod,
                feeRef: settled.feeRef,
                identityKey: target.operation.payload.identityKey,
                revision: settled.current.definition.revision.revision,
                revisionId: settled.current.definition.revision.revisionId,
                scheduleRevision: settled.scheduleRevision,
              },
              identityKey: target.operation.payload.identityKey,
              intent: 'RETIRE_CURRENT',
              reason: 'Otherwise valid Current Fee retirement',
            },
          },
        };
      }),
    { concurrency: 1 },
  );
  const retirement = yield* Schema.decodeUnknownEffect(ManageProductCommercialFeesBulkPayloadSchema)({
    ...input,
    targetIntents: retirementTargets,
  });
  const mutations = [retirement];
  for (const targetIntents of [
    prepared.map((target) => ({
      ...target,
      operation: {
        ...target.operation,
        payload: {
          ...target.operation.payload,
          effectivePeriod: {
            effectiveFrom: DateTime.formatIso(DateTime.add(tC, { seconds: 1 })),
            effectiveTo: scheduledTo,
          },
        },
      },
    })),
    prepared.map((target) => ({
      ...target,
      operation: {
        ...target.operation,
        payload: {
          ...target.operation.payload,
          effectivePeriod: {
            effectiveFrom: scheduledFrom,
            effectiveTo: DateTime.formatIso(DateTime.add(tD, { seconds: 1 })),
          },
        },
      },
    })),
    prepared.map((target) => ({
      ...target,
      operation: {
        ...target.operation,
        payload: {
          ...target.operation.payload,
          expectedScheduleRevision: target.operation.payload.expectedScheduleRevision + 1,
        },
      },
    })),
  ]) {
    mutations.push(
      yield* Schema.decodeUnknownEffect(ManageProductCommercialFeesBulkPayloadSchema)({
        ...input,
        targetIntents,
      }),
    );
  }
  const conflictedKeys: string[] = [];
  for (const changed of mutations) {
    const key = yield* nextId;
    conflictedKeys.push(key);
    const result = yield* registered.callFee(changed, key);
    expect(result.outcomes.map((row) => row.outcome)).toEqual(['CONFLICT', 'CONFLICT']);
    expect(result.outcomes.map((row) => (row.outcome === 'CONFLICT' ? row.reasonCode : ''))).toEqual([
      'IDEMPOTENCY_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
    ]);
    expect(yield* observe()).toEqual(committed);
    const sameKeyFailure = yield* registered.callFee(changed, k1).pipe(Effect.flip);
    expect(
      yield* Schema.decodeUnknownEffect(ManageProductCommercialFeesBulkActionConflictProblemSchema)(sameKeyFailure),
    ).toMatchObject({ code: 'action_request_hash_conflict', status: 409 });
    expect(yield* observe()).toEqual(committed);
  }
  const finalEvidence = yield* registered.evidence();
  for (const key of [k2, ...conflictedKeys]) {
    const invocation = finalEvidence.invocations.find((row) => row.idempotencyKey === key);
    expect(invocation?.status).toBe('succeeded');
    const audits = finalEvidence.audits.filter(
      (row) => row.actionInvocationId === invocation?.actionInvocationId && row.eventType === 'action.executed',
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.evidenceJson).toMatchObject({
      conflicts: key === k2 ? 0 : 2,
      retired: 0,
      scheduled: key === k2 ? 2 : 0,
      targetCount: 2,
    });
  }
  expect(DateTime.formatIso(DateTime.makeUnsafe(yield* nativeClock.currentTimeMillis)) < scheduledTo).toBe(true);
  expect(yield* observe()).toEqual(committed);
  const observeIntentReceipts = (targets: readonly { readonly intentId: string }[]) =>
    fixture
      .prepareOwner(
        Effect.fn('BulkOriginalIntent.observeFeeRaceReceipts')(function* observeFeeRaceReceipts(transaction, scope) {
          const fees = yield* commercialFeePersistenceForScope(transaction, scope);
          return yield* Effect.forEach(
            targets,
            (target) =>
              fees.lookupResult({
                actionInvocationId: productCommercialFeeBulkActionInvocationIdFor(scope.tenantId, target.intentId),
              }),
            { concurrency: 1 },
          );
        }),
        'required',
      )
      .pipe(Effect.provideContext(registered.context));
  yield* Effect.gen(function* verifyFeeRaces() {
    // Each call is a separate public Core transaction with its own fresh assertion and outer key.
    // Equal amount under a new I still schedules a distinct lawful owner revision.
    const futureTargets = yield* Effect.forEach(
      prepared,
      (target, index) =>
        Effect.gen(function* futureFeeTarget() {
          const basis = committed[index];
          if (basis === undefined) {
            return yield* Effect.die('Future Fee requires its actual committed schedule basis');
          }
          return {
            ...target,
            intentId: `TEST:1278:fee-exact-race:${yield* nextId}`,
            operation: {
              ...target.operation,
              payload: {
                ...target.operation.payload,
                effectivePeriod: {
                  effectiveFrom: DateTime.formatIso(DateTime.add(tD, { seconds: 10 })),
                  effectiveTo: DateTime.formatIso(DateTime.add(tD, { seconds: 20 })),
                },
                expectedScheduleRevision: basis.scheduleRevision,
                reason: 'Distinct I equal-amount future Fee schedule',
              },
            },
          };
        }),
      { concurrency: 1 },
    );
    const futureInput = yield* Schema.decodeUnknownEffect(ManageProductCommercialFeesBulkPayloadSchema)({
      ...input,
      targetIntents: futureTargets,
    });
    const exactRaceKeys = [yield* nextId, yield* nextId];
    const exactRace = yield* Effect.all(
      exactRaceKeys.map((key) => registered.callFee(futureInput, key)),
      { concurrency: 2 },
    );
    for (const target of futureTargets) {
      const rows = exactRace.flatMap((result) =>
        result.outcomes.filter((row) => row.identity.targetId === target.identity.targetId),
      );
      expect(rows.map((row) => row.outcome)).toEqual(['SCHEDULED', 'SCHEDULED']);
      expect(rows.map((row) => row.resolvedBy).toSorted()).toEqual(['OWNER_COMMAND', 'OWNER_RECONCILIATION']);
      const [first, second] = rows;
      if (first === undefined || second === undefined || !('canonical' in second)) {
        return yield* Effect.die('Both separate exact-I transactions must return the settled canonical Fee');
      }
      expect(first).toMatchObject({ canonical: second.canonical });
    }
    const afterExactRace = yield* observe(3);
    for (const [index, after] of afterExactRace.entries()) {
      const before = committed[index];
      if (before === undefined) {
        return yield* Effect.die('Every raced Fee needs its original durable state');
      }
      expect(after.receipt).toEqual(before.receipt);
      expect(after.current).toEqual(before.current);
      expect(
        after.revisions.filter((revision) =>
          before.revisions.some(
            (original) => original.definition.revision.revisionId === revision.definition.revision.revisionId,
          ),
        ),
      ).toEqual(before.revisions);
      expect(after.scheduleRevision).toBe(before.scheduleRevision + 1);
    }
    const exactRaceReceipts = yield* observeIntentReceipts(futureTargets);
    for (const receipt of exactRaceReceipts) {
      expect(receipt).toMatchObject({ outcome: 'COMMERCIAL_FEE_ACTION_RESULT_FOUND' });
    }
    // Same fresh I, same F3 and real CAS; only the canonical reason differs.
    const changedRaceTargets = yield* Effect.forEach(
      futureTargets,
      (target, index) =>
        Effect.gen(function* changedFeeRaceTarget() {
          const basis = afterExactRace[index];
          if (basis === undefined) {
            return yield* Effect.die('Changed-intent race needs the actual F2 schedule basis');
          }
          return {
            ...target,
            intentId: `TEST:1278:fee-changed-race:${yield* nextId}`,
            operation: {
              ...target.operation,
              payload: {
                ...target.operation.payload,
                effectivePeriod: {
                  effectiveFrom: DateTime.formatIso(DateTime.add(tD, { seconds: 30 })),
                  effectiveTo: DateTime.formatIso(DateTime.add(tD, { seconds: 40 })),
                },
                expectedScheduleRevision: basis.scheduleRevision,
                reason: 'Competing original Fee reason A',
              },
            },
          };
        }),
      { concurrency: 1 },
    );
    const changedRaceA = yield* Schema.decodeUnknownEffect(ManageProductCommercialFeesBulkPayloadSchema)({
      ...input,
      targetIntents: changedRaceTargets,
    });
    const changedRaceB = yield* Schema.decodeUnknownEffect(ManageProductCommercialFeesBulkPayloadSchema)({
      ...input,
      targetIntents: changedRaceTargets.map((target) => ({
        ...target,
        operation: {
          ...target.operation,
          payload: { ...target.operation.payload, reason: 'Competing original Fee reason B' },
        },
      })),
    });
    const changedRaceKeyA = yield* nextId;
    const changedRaceKeyB = yield* nextId;
    const changedRaceKeys = [changedRaceKeyA, changedRaceKeyB];
    const changedRace = yield* Effect.all(
      [registered.callFee(changedRaceA, changedRaceKeyA), registered.callFee(changedRaceB, changedRaceKeyB)],
      { concurrency: 2 },
    );
    for (const target of changedRaceTargets) {
      const rows = changedRace.flatMap((result) =>
        result.outcomes.filter((row) => row.identity.targetId === target.identity.targetId),
      );
      expect(rows.map((row) => row.outcome).toSorted()).toEqual(['CONFLICT', 'SCHEDULED']);
      expect(rows.filter((row) => row.outcome === 'CONFLICT')).toMatchObject([{ reasonCode: 'IDEMPOTENCY_CONFLICT' }]);
    }
    const afterChangedRace = yield* observe(4);
    for (const [index, after] of afterChangedRace.entries()) {
      const before = afterExactRace[index];
      if (before === undefined) {
        return yield* Effect.die('Each changed race needs its previous committed state');
      }
      expect(after.receipt).toEqual(before.receipt);
      expect(after.current).toEqual(before.current);
      expect(
        after.revisions.filter((revision) =>
          before.revisions.some(
            (original) => original.definition.revision.revisionId === revision.definition.revision.revisionId,
          ),
        ),
      ).toEqual(before.revisions);
      expect(after.scheduleRevision).toBe(before.scheduleRevision + 1);
    }
    expect(yield* observeIntentReceipts(futureTargets)).toEqual(exactRaceReceipts);
    const changedRaceReceipts = yield* observeIntentReceipts(changedRaceTargets);
    for (const receipt of changedRaceReceipts) {
      expect(receipt).toMatchObject({ outcome: 'COMMERCIAL_FEE_ACTION_RESULT_FOUND' });
    }
    // A genuinely absent new I reaches native CAS, takes the typed P7603 subtransaction path,
    // and leaves no claim/receipt or revision. It cannot be mistaken for old-I reconciliation.
    const staleTargets = yield* Effect.forEach(
      changedRaceTargets,
      (target, index) =>
        Effect.gen(function* staleFeeTarget() {
          const stale = committed[index];
          if (stale === undefined) {
            return yield* Effect.die('The stale CAS control needs the genuine earlier basis');
          }
          return {
            ...target,
            intentId: `TEST:1278:fee-stale-cas:${yield* nextId}`,
            operation: {
              ...target.operation,
              payload: {
                ...target.operation.payload,
                effectivePeriod: {
                  effectiveFrom: DateTime.formatIso(DateTime.add(tD, { seconds: 50 })),
                  effectiveTo: DateTime.formatIso(DateTime.add(tD, { seconds: 60 })),
                },
                expectedScheduleRevision: stale.scheduleRevision,
                reason: 'Fresh I with genuinely stale Fee schedule CAS',
              },
            },
          };
        }),
      { concurrency: 1 },
    );
    const staleInput = yield* Schema.decodeUnknownEffect(ManageProductCommercialFeesBulkPayloadSchema)({
      ...input,
      targetIntents: staleTargets,
    });
    const staleKey = yield* nextId;
    const staleResult = yield* registered.callFee(staleInput, staleKey);
    expect(staleResult.outcomes.map((row) => row.outcome)).toEqual(['CONFLICT', 'CONFLICT']);
    expect(staleResult.outcomes.map((row) => (row.outcome === 'CONFLICT' ? row.reasonCode : ''))).toEqual([
      'EXPECTED_SCHEDULE_STALE',
      'EXPECTED_SCHEDULE_STALE',
    ]);
    for (const receipt of yield* observeIntentReceipts(staleTargets)) {
      expect(receipt).toMatchObject({ outcome: 'COMMERCIAL_FEE_ACTION_RESULT_ABSENT' });
    }
    expect(yield* observe(4)).toEqual(afterChangedRace);
    expect(yield* observeIntentReceipts(futureTargets)).toEqual(exactRaceReceipts);
    expect(yield* observeIntentReceipts(changedRaceTargets)).toEqual(changedRaceReceipts);
    const postRaceEvidence = yield* registered.evidence();
    for (const key of [...exactRaceKeys, ...changedRaceKeys, staleKey]) {
      const invocation = postRaceEvidence.invocations.find((row) => row.idempotencyKey === key);
      expect(invocation?.status).toBe('succeeded');
      const audits = postRaceEvidence.audits.filter(
        (row) => row.actionInvocationId === invocation?.actionInvocationId && row.eventType === 'action.executed',
      );
      expect(audits).toHaveLength(1);
      const result =
        key === staleKey
          ? staleResult
          : (exactRace[exactRaceKeys.indexOf(key)] ?? changedRace[changedRaceKeys.indexOf(key)]);
      if (result === undefined) {
        return yield* Effect.die('Every raced invocation must retain its settled public result');
      }
      expect(audits[0]?.evidenceJson).toMatchObject({
        conflicts: result.outcomes.filter((row) => row.outcome === 'CONFLICT').length,
        retired: 0,
        scheduled: result.outcomes.filter((row) => row.outcome === 'SCHEDULED').length,
        targetCount: 2,
      });
    }
    yield* catalog.stop();
    const unavailable = yield* registered.callFee(input, yield* nextId).pipe(Effect.flip);
    expect(
      yield* Schema.decodeUnknownEffect(ManageProductCommercialFeesBulkActionUnavailableProblemSchema)(unavailable),
    ).toMatchObject({
      code: 'pricing_catalog_selection_unavailable',
      status: 503,
    });
    expect(yield* observe(4)).toEqual(afterChangedRace);
    expect(yield* observeIntentReceipts(futureTargets)).toEqual(exactRaceReceipts);
    expect(yield* observeIntentReceipts(changedRaceTargets)).toEqual(changedRaceReceipts);
    return yield* Effect.void;
  }).pipe(Effect.withSpan('BulkOriginalIntent.verifyFeeRaces'));
  return yield* Effect.void;
}, Effect.scoped);

it.layer(nativeServices, { excludeTestServices: true })((suite) =>
  suite.effect(
    'recovers registered Fee scheduling at real Current time without reinterpreting it as retirement (#1278)',
    registeredFeeOriginalIntentTest,
    { timeout: 120_000 },
  ),
);
