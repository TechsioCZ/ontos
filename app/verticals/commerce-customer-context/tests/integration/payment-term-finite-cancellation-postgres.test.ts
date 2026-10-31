import { randomUUID } from 'node:crypto';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import {
  ActionPermissionDenied,
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
  ContextAccessLive,
  defineScopedRoutine,
  loadDatabaseConnectionPair,
  OperationContextDenied,
  runAction,
  ReadRuntime,
  ScopedRoutineInvocationError,
} from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { PgClient } from '@effect/sql-pg';
import { PaymentTermDefinitionSchema } from '@app/payment-term-catalog-contracts/payment-term';
import {
  CurrentPaymentTermsRequestSchema,
  CurrentPaymentTermsResponseSchema,
} from '@app/payment-term-catalog-contracts/current-payment-terms';
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import {
  Config,
  Context,
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
import { Reactivity } from 'effect/reactivity';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';
import type { RemoveCustomerPaymentTermPayload } from '../../shared/actions/remove-customer-payment-term.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { PaymentTermCatalogGatewayCredentialService } from '../../shared/domain/payment-term-catalog-gateway-credential.ts';
import { removeCustomerPaymentTerm } from '../../shared/domain/payment-terms.ts';
import type { changeCustomerPaymentTerms } from '../../shared/domain/payment-terms.ts';
import {
  CustomerPaymentTermsActionRejected,
  changeCustomerPaymentTermsAction,
} from '../../src/actions/change-customer-payment-terms.action.ts';
import { removeCustomerPaymentTermAction } from '../../src/actions/remove-customer-payment-term.action.ts';
import { customerPaymentTermEntitlementReadRead } from '../../src/api/customer-payment-term-entitlement-read.read.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import { profileRetailPermissionReaderFactoryLive } from '../../src/integrations/retail-permission-reader.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import { enrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeCrypto.layer),
);
const row = Schema.Struct({ outcome: Schema.String, payload: Schema.Unknown });
const ensureProfile = defineScopedRoutine({
  name: 'ensure_counterparty_profile',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: row,
  routineKey: 'test.payment-entitlement.ensure-profile',
  schema: 'commerce_customer_context',
});
const ProfileSchema = Schema.Struct({
  profileRef: Schema.Struct({ resourceId: Schema.String.pipe(Schema.brand('NativeCounterpartyProfileId')) }),
});
const beginGrant = defineScopedRoutine({
  name: 'begin_access_grant',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'boolean' },
  ],
  resultSchema: Schema.Struct({ grant_id: Schema.String, mutation_id: Schema.String }),
  routineKey: 'test.payment-entitlement.begin-access',
  schema: 'commerce_customer_context',
});
const activateGrant = defineScopedRoutine({
  name: 'transition_access_grant',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: Schema.Struct({ state: Schema.String }),
  routineKey: 'test.payment-entitlement.activate-access',
  schema: 'commerce_customer_context',
});
const readOwner = defineScopedRoutine({
  name: 'read_customer_payment_terms',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
  ],
  resultSchema: row,
  routineKey: 'test.payment-entitlement.scoped-read',
  schema: 'commerce_customer_context',
});
const persist = defineScopedRoutine({
  name: 'persist_customer_payment_terms',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: row,
  routineKey: 'test.payment-entitlement.persist-control',
  schema: 'commerce_customer_context',
});

const expectSqlRejection = (result: Result.Result<unknown, unknown>, code: string): void => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(Schema.is(ScopedRoutineInvocationError)(result.failure)).toBe(true);
    if (Schema.is(ScopedRoutineInvocationError)(result.failure)) {
      expect(result.failure.postgresCode).toEqual(Option.some(code));
    }
  }
};

const journalFingerprint = Effect.fn('FiniteEntitlement.journalFingerprint')(function* journalFingerprint(
  connection: {
    readonly connectionString: string;
    readonly database: string;
    readonly user: string;
  },
  owner: 'ccc' | 'core' = 'ccc',
) {
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
      owner === 'core'
        ? "set time zone 'UTC'; select md5(coalesce(jsonb_agg(to_jsonb(journal) order by to_jsonb(journal)::text)::text,'[]')) from drizzle.__drizzle_migrations_core journal"
        : "set time zone 'UTC'; select md5(coalesce(jsonb_agg(to_jsonb(journal) order by to_jsonb(journal)::text)::text,'[]')) from drizzle.__drizzle_migrations_commerce_customer_context journal",
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
const copyOwnerBookkeeping = Effect.fn('FiniteEntitlement.copyOwnerBookkeeping')(function* copyOwnerBookkeeping(
  connections: {
    readonly admin: { readonly connectionString: string; readonly database: string; readonly user: string };
  },
  owner: 'ccc' | 'core' = 'ccc',
) {
  const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const before = yield* journalFingerprint(source.admin, owner);
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
      owner === 'core' ? 'drizzle.__drizzle_migrations_core' : 'drizzle.__drizzle_migrations_commerce_customer_context',
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
  expect(yield* journalFingerprint(connections.admin, owner)).toBe(before);
  expect(yield* journalFingerprint(source.admin, owner)).toBe(before);
});

// Actual CLI/full immutable journal. Child-only configuration never changes the source database.
/** Core migrates through its own convergent db:migrate; a plain `drizzle-kit migrate` replays both of its lineages. */
const ownerMigrationCommand = (owner: 'ccc' | 'core', command: 'migrate' | 'verify', configuration: string) => {
  if (owner === 'core') {
    return ['db:migrate'];
  }
  return command === 'migrate'
    ? ['exec', 'drizzle-kit', 'migrate', '--config', configuration]
    : ['exec', 'node', 'scripts/verify-db-schema.mts'];
};

const migrateOwner = Effect.fn('FiniteEntitlement.migrateOwner')(function* migrateOwner(
  connections: {
    readonly admin: { readonly connectionString: string };
    readonly runtime: { readonly connectionString: string };
  },
  command: 'migrate' | 'verify' = 'migrate',
  beforeFiniteForward = false,
  owner: 'ccc' | 'core' = 'ccc',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-payment-entitlement-' });
  const history = new URL(
    owner === 'core' ? '../../../../packages/core-runtime/drizzle/' : '../../drizzle/',
    import.meta.url,
  ).pathname;
  const migrations = beforeFiniteForward === true ? path.join(directory, 'prefix') : history;
  if (beforeFiniteForward === true) {
    yield* fs.makeDirectory(migrations);
    for (const folder of yield* fs.readDirectory(history)) {
      if (folder < '20261019151457_finite-entitlement-cancellation') {
        yield* fs.copy(path.join(history, folder), path.join(migrations, folder));
      }
    }
  }
  const configuration = path.join(directory, 'drizzle.config.mjs');
  yield* fs.writeFileString(
    configuration,
    `export default { dialect:'postgresql', out:process.env.ONTOS_CCC_ENTITLEMENT_MIGRATIONS, schema:process.env.ONTOS_CCC_ENTITLEMENT_SCHEMA, dbCredentials:{url:process.env.DATABASE_ADMIN_URL}, migrations:{schema:'drizzle',table:process.env.ONTOS_ENTITLEMENT_JOURNAL} };`,
  );
  const ownerCommand = ownerMigrationCommand(owner, command, configuration);
  const child = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      '--filter',
      owner === 'core' ? '@app/core-runtime' : '@app/commerce-customer-context',
      ...ownerCommand,
    ],
    {
      cwd: new URL('../../../../', import.meta.url).pathname,
      env: {
        DATABASE_ADMIN_URL: connections.admin.connectionString,
        DATABASE_URL: connections.runtime.connectionString,
        ONTOS_CCC_ENTITLEMENT_MIGRATIONS: migrations,
        ONTOS_CCC_ENTITLEMENT_SCHEMA: new URL(
          owner === 'core' ? '../../../../packages/core-runtime/src/db/schema.ts' : '../../src/database/schema.ts',
          import.meta.url,
        ).pathname,
        ONTOS_ENTITLEMENT_JOURNAL:
          owner === 'core' ? '__drizzle_migrations_core' : '__drizzle_migrations_commerce_customer_context',
      },
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  );
  const [status, diagnostics] = yield* Effect.all(
    [child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.runCollect), Stream.runDrain(child.stdout)],
    { concurrency: 3 },
  );
  if (Number(status) !== 0) {
    const text = diagnostics.join('');
    const sqlState = /(?:code|sqlState|sqlstate):\s*['"](?<sqlState>[A-Z0-9]{5})['"]/u.exec(text)?.groups?.sqlState;
    const position = /position:\s*['"]?(?<position>\d+)/u.exec(text)?.groups?.position;
    yield* Effect.logError({
      failureClass: 'MIGRATION_CHILD_FAILURE',
      knownLeasedBoundary: '20261019151457_finite-entitlement-cancellation',
      position: position ?? 'UNAVAILABLE',
      sqlState: sqlState ?? 'UNAVAILABLE',
    });
  }
  expect(Number(status)).toBe(0);
});

const makeOwnerStorage = Effect.fn('FiniteEntitlement.makeOwnerStorage')(function* makeOwnerStorage(
  mode: 'empty' | 'schema-only',
  snapshot: Effect.Success<typeof enrollmentApplicationCompositionSnapshot>,
) {
  const isolated =
    mode === 'empty'
      ? yield* makeIsolatedNativeDatabaseFixture({ mode: 'empty', purpose: 'stabilization-1229-payment-entitlement' })
      : yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'stabilization-1229-payment-entitlement',
        });
  if (mode === 'empty') {
    yield* isolated.migrateCoreSchema();
    yield* isolated.publishInitialComposition(snapshot);
  }
  const adminServices = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
    Effect.provide(adminServices),
  );
  const [old] = yield* admin.execute<{ readonly installed: boolean }>(
    sql`select exists(select 1 from information_schema.columns where table_schema='commerce_customer_context' and table_name='customer_payment_term_entitlements' and column_name='grant_schedule_known') as installed`,
    'objects',
  );
  if (mode === 'schema-only') {
    const [before] = yield* admin.execute<{ readonly count: number }>(
      sql`select count(*)::integer as count from drizzle.__drizzle_migrations_commerce_customer_context`,
      'objects',
    );
    expect(before?.count).toBe(0);
    yield* copyOwnerBookkeeping(isolated.connections, 'core');
    yield* migrateOwner(isolated.connections, 'migrate', false, 'core');
    yield* migrateOwner(isolated.connections, 'migrate', false, 'core');
    yield* copyOwnerBookkeeping(isolated.connections);
    const [after] = yield* admin.execute<{ readonly count: number }>(
      sql`select count(*)::integer as count from drizzle.__drizzle_migrations_commerce_customer_context`,
      'objects',
    );
    expect(after?.count).toBeGreaterThan(0);
  }
  const legacySource = mode === 'empty' || !old.installed;
  // The upgraded case may initially clone pre-forward source schema. New proof always migrates its own DB only.
  if (mode === 'empty') {
    yield* migrateOwner(isolated.connections, 'migrate', true);
  }
  return { admin, isolated, legacySource };
});

const scenario = Effect.fn('FiniteEntitlement.nativeScenario')(function* nativeScenario(mode: 'empty' | 'schema-only') {
  const snapshot = yield* enrollmentApplicationCompositionSnapshot;
  const { admin, isolated, legacySource } = yield* makeOwnerStorage(mode, snapshot);
  const coreEvidenceContext = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceContext));
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionKeys: [
        changeCustomerPaymentTermsAction.descriptor.actionKey,
        removeCustomerPaymentTermAction.descriptor.actionKey,
      ],
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['commerce-customer-context'],
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      moduleKeys: ['commerce.customer-context'],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (resource) => resource.close().pipe(Effect.orDie),
  );
  const owner = commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(
    Layer.provide(profileRetailPermissionReaderFactoryLive),
    Layer.provide(ContextAccessLive),
  );
  const server = yield* HttpServer.HttpServer;
  if (!Schema.is(Schema.Struct({ port: Schema.Number }))(server.address)) {
    return yield* Effect.die('Missing native catalog fixture port');
  }
  const origin = new URL(`http://127.0.0.1:${server.address.port}`);
  let requests = 0;
  // Published dependency HTTP fixture: real CCC generated client/factory, not a canonical Payment owner implementation.
  yield* server.serve(
    Effect.gen(function* currentCatalogFixture() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const input = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CurrentPaymentTermsRequestSchema)),
      );
      expect(request.headers.authorization).toBe('Bearer bounded-native-catalog-credential');
      requests += 1;
      const provenance = {
        actionInvocationId: randomUUID(),
        actorPrincipalId: fixture.manager.principalId,
        at: '2020-01-01T00:00:00.000Z',
        reason: 'Published dependency fixture',
      };
      const current = input.references.map(({ paymentTermRef }) =>
        Schema.decodeUnknownSync(PaymentTermDefinitionSchema)({
          code: `NATIVE_${paymentTermRef.resourceId.toUpperCase().replaceAll('-', '')}`,
          compatibilityId: 'immediate.v1',
          created: provenance,
          definitionRevisionId: randomUUID(),
          description: 'Native finite entitlement dependency fixture',
          lifecycle: { effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveTo: null, state: 'ACTIVE' },
          metadataRevision: 1,
          name: 'Immediate',
          paymentTermRef,
          retired: null,
          semanticFingerprint: 'a'.repeat(64),
          semanticRevisionId: paymentTermRef.resourceId,
          semantics: { calculationRuleVersion: 2, calendarRule: 'NOT_APPLICABLE', kind: 'IMMEDIATE' },
          updated: provenance,
        }),
      );
      const response = yield* Schema.decodeUnknownEffect(CurrentPaymentTermsResponseSchema)({
        current,
        effectiveAt: input.at,
        observedAt: input.at,
        referenceOutcomes: current.map((definition) => ({
          definition,
          kind: 'USABLE',
          requestedPaymentTermRef: definition.paymentTermRef,
        })),
        truncated: false,
      });
      return yield* HttpServerResponse.json(response);
    }),
  );
  const context = yield* Layer.build(
    Layer.mergeAll(
      fixture.layer.pipe(Layer.provide(owner)),
      FetchHttpClient.layer,
      Layer.succeed(PaymentTermCatalogGatewayCredentialService, {
        issue: () =>
          Effect.succeed({ baseUrl: origin, credential: Redacted.make('Bearer bounded-native-catalog-credential') }),
      }),
    ),
  );
  const businessContext = yield* Layer.build(BusinessPermissionRelationshipMutationLive);
  const business = Context.get(businessContext, BusinessPermissionRelationshipMutation);
  const counterpartyRef = {
    moduleId: 'party.registry',
    resourceId: randomUUID(),
    resourceType: 'party.registry.counterparty',
    tenantId: fixture.tenantId,
  } as const;
  const profileId = yield* fixture
    .prepareOwner(
      (transaction) =>
        Effect.gen(function* prepareCounterparty() {
          const [created] = yield* transaction.invoke(ensureProfile, [
            counterpartyRef.resourceId,
            null,
            randomUUID(),
            'native-role-revision',
            '2020-01-01T00:00:00.000Z',
            'AUTHORIZED_ONBOARDING',
            randomUUID(),
            fixture.manager.principalId,
          ]);
          expect(created?.outcome).toBe('PROFILE_CREATED');
          if (created === undefined) {
            return yield* Effect.die('No owner Profile result');
          }
          const profile = yield* Schema.decodeUnknownEffect(ProfileSchema)(created.payload);
          return profile.profileRef.resourceId;
        }),
      'required',
    )
    .pipe(Effect.provideContext(context));
  const profileRef = {
    moduleId: 'commerce.customer-context',
    resourceId: profileId,
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId: fixture.tenantId,
  } as const;
  yield* fixture.grantResourceAccess(profileRef, fixture.manager.principalId);
  for (const permission of ['counterparty.settings.payment_terms.manage', 'counterparty.profile.read'] as const) {
    const grant = {
      permission,
      principal: { principalId: fixture.manager.principalId, tenantId: fixture.tenantId },
      target: {
        counterpartyId: counterpartyRef.resourceId,
        kind: 'counterparty' as const,
        legalEntityId: fixture.legalEntityId,
        tenantId: fixture.tenantId,
      },
    };
    const pending = yield* fixture
      .prepareOwner(
        (transaction) =>
          transaction.invoke(beginGrant, [
            counterpartyRef.resourceId,
            fixture.manager.principalId,
            permission,
            null,
            fixture.manager.principalId,
            randomUUID(),
            'Native entitlement proof',
            false,
          ]),
        'required',
      )
      .pipe(Effect.provideContext(context));
    yield* business.mutate({ ...grant, operation: 'grant' });
    yield* Effect.addFinalizer(() => business.mutate({ ...grant, operation: 'revoke' }).pipe(Effect.orDie));
    const [intent] = pending;
    if (intent === undefined) {
      return yield* Effect.die('No owner access grant intent');
    }
    yield* fixture
      .prepareOwner(
        (transaction) => transaction.invoke(activateGrant, [intent.grant_id, intent.mutation_id, 'grant', 'ACTIVE']),
        'required',
      )
      .pipe(Effect.provideContext(context));
  }
  const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
  const executeChange = (
    changes: Parameters<typeof changeCustomerPaymentTerms>[0]['changes'],
    expectedRevision: number,
  ) =>
    runAction({
      payload: { changes, counterpartyRef, expectedRevision, profileRef, reason: 'Finite entitlement native producer' },
      principal,
      registration: changeCustomerPaymentTermsAction,
      transport: {
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        targetModuleKey: 'commerce.customer-context',
      },
    }).pipe(Effect.provideContext(context));
  const executeRemoval = (input: RemoveCustomerPaymentTermPayload, idempotencyKey = randomUUID()) =>
    runAction({
      payload: input,
      principal,
      registration: removeCustomerPaymentTermAction,
      transport: { correlationId: randomUUID(), idempotencyKey, targetModuleKey: 'commerce.customer-context' },
    }).pipe(Effect.provideContext(context));
  const entitlementRef = {
    moduleId: 'commerce.customer-context',
    resourceId: randomUUID(),
    resourceType: 'commerce.customer-context.customer-payment-term-entitlement',
    tenantId: fixture.tenantId,
  } as const;
  const paymentTermRef = {
    moduleId: 'payment.term-catalog',
    resourceId: randomUUID(),
    resourceType: 'payment.term-catalog.payment-term',
    tenantId: fixture.tenantId,
  } as const;
  const grant = {
    _tag: 'GRANT_ENTITLEMENT',
    effectiveFrom: '2030-01-01T00:00:00.000Z',
    effectiveTo: '2030-06-01T00:00:00.000Z',
    entitlementRef,
    paymentTermRef,
    semanticRevisionId: paymentTermRef.resourceId,
  } as const;
  let baseline = 1;
  const legacyEndedRef = { ...entitlementRef, resourceId: randomUUID() };
  const legacyOpenRef = { ...entitlementRef, resourceId: randomUUID() };
  const legacyCancelledRef = { ...entitlementRef, resourceId: randomUUID() };
  const retainedLegacyRows = () =>
    admin.execute<{ readonly snapshot: string }>(
      sql`select coalesce(jsonb_agg(to_jsonb(e) - 'grant_schedule_known' - 'original_effective_to' - 'ended_at' - 'cancelled_at' order by customer_payment_term_entitlement_id),'[]'::jsonb)::text as snapshot from commerce_customer_context.customer_payment_term_entitlements e where customer_profile_id=${profileId}::uuid`,
      'objects',
    );
  let legacyBefore: readonly { readonly snapshot: string }[] = [];
  if (legacySource) {
    const { effectiveTo: _originalFiniteEnd, ...originalOpenGrant } = grant;
    const legacyGrant = yield* executeChange(
      [
        grant,
        {
          ...originalOpenGrant,
          entitlementRef: legacyEndedRef,
          paymentTermRef: { ...paymentTermRef, resourceId: legacyEndedRef.resourceId },
          semanticRevisionId: legacyEndedRef.resourceId,
        },
        { _tag: 'END_ENTITLEMENT', effectiveAt: grant.effectiveTo, entitlementRef: legacyEndedRef },
      ],
      1,
    );
    expect(legacyGrant.state.entitlements[0]?.originalEffectiveTo).toBeUndefined();
    // Known producer input supplies this SQL-only RED; it does not reclassify persisted legacy state.
    const known = {
      ...legacyGrant.state,
      entitlements: legacyGrant.state.entitlements.map((entitlement) => ({
        ...entitlement,
        originalEffectiveTo: grant.effectiveTo,
      })),
    };
    const removed = removeCustomerPaymentTerm({
      effectiveAt: '2029-01-01T00:00:00.000Z',
      entitlementRef,
      expectedRevision: known.revision,
      state: known,
    });
    expect(Predicate.isTagged(removed, 'REMOVED')).toBe(true);
    if (!Predicate.isTagged(removed, 'REMOVED')) {
      return yield* Effect.die('Missing SQL RED input');
    }
    const rejected = yield* fixture
      .prepareOwner(
        (transaction) =>
          transaction.invoke(persist, [
            {
              actionInvocationId: randomUUID(),
              changed: true,
              counterpartyResourceId: counterpartyRef.resourceId,
              expectedRevision: known.revision,
              principalId: fixture.manager.principalId,
              profileKind: 'COUNTERPARTY',
              profileResourceId: profileId,
              reason: 'Pre-forward SQL control',
              state: removed.state,
            },
          ]),
        'required',
      )
      .pipe(Effect.provideContext(context), Effect.result);
    expectSqlRejection(rejected, '22023');
    const { effectiveTo: _finiteEnd, ...openGrant } = grant;
    const openGrants = [legacyOpenRef, legacyCancelledRef].map((reference) => {
      const term = { ...paymentTermRef, resourceId: randomUUID() };
      return { ...openGrant, entitlementRef: reference, paymentTermRef: term, semanticRevisionId: term.resourceId };
    });
    const withOpen = yield* executeChange(openGrants, legacyGrant.state.revision);
    const cancelledLegacy = yield* executeRemoval({
      counterpartyRef,
      effectiveAt: '2029-01-01T00:00:00.000Z',
      entitlementRef: legacyCancelledRef,
      expectedRevision: withOpen.state.revision,
      profileRef,
      reason: 'Supported old-writer cancellation',
    });
    baseline = cancelledLegacy.state.revision;
    legacyBefore = yield* retainedLegacyRows();
  }
  yield* migrateOwner(isolated.connections);
  const [journalBefore] = yield* admin.execute<{ readonly journal: string }>(
    sql`select json_agg(row_to_json(j) order by name)::text as journal from drizzle.__drizzle_migrations_commerce_customer_context j`,
    'objects',
  );
  yield* migrateOwner(isolated.connections);
  const [journalAfter] = yield* admin.execute<{ readonly journal: string }>(
    sql`select json_agg(row_to_json(j) order by name)::text as journal from drizzle.__drizzle_migrations_commerce_customer_context j`,
    'objects',
  );
  expect(journalAfter).toEqual(journalBefore);
  const routineConfiguration = yield* admin.execute<{
    readonly configuration: readonly string[];
    readonly name: string;
  }>(
    sql`select proname as name, proconfig as configuration from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='commerce_customer_context'
      and p.proname in ('customer_payment_terms_state_json','persist_customer_payment_terms')
      order by p.proname`,
    'objects',
  );
  expect(routineConfiguration).toHaveLength(2);
  for (const routine of routineConfiguration) {
    expect(routine.configuration).toContain('search_path=pg_catalog, commerce_customer_context, pg_temp');
  }
  yield* migrateOwner(isolated.connections, 'verify');
  const freshRef = { ...entitlementRef, resourceId: randomUUID() };
  const freshTerm = { ...paymentTermRef, resourceId: randomUUID() };
  if (legacySource) {
    expect(yield* retainedLegacyRows()).toEqual(legacyBefore);
    const before = yield* fixture.evidence(coreEvidenceExecutor);
    const legacyPayload = {
      counterpartyRef,
      effectiveAt: '2029-01-01T00:00:00.000Z',
      entitlementRef,
      expectedRevision: baseline,
      profileRef,
      reason: 'Legacy provenance compatibility',
    };
    const cancelledReplay = yield* executeRemoval({ ...legacyPayload, entitlementRef: legacyCancelledRef });
    expect(cancelledReplay.changed).toBe(false);
    expect(
      cancelledReplay.state.entitlements.find((entry) => entry.entitlementRef.resourceId === entitlementRef.resourceId),
    ).toMatchObject({ effectiveTo: grant.effectiveTo });
    expect(
      cancelledReplay.state.entitlements.find((entry) => entry.entitlementRef.resourceId === entitlementRef.resourceId)
        ?.originalEffectiveTo,
    ).toBeUndefined();
    expect(
      cancelledReplay.state.entitlements.find((entry) => entry.entitlementRef.resourceId === entitlementRef.resourceId)
        ?.endedAt,
    ).toBeUndefined();
    expect(yield* retainedLegacyRows()).toEqual(legacyBefore);
    const after = yield* fixture.evidence(coreEvidenceExecutor);
    expect(after.events).toHaveLength(before.events.length);
    expect(after.outbox).toHaveLength(before.outbox.length);
    const explicitEnd = yield* executeRemoval({ ...legacyPayload, entitlementRef: legacyEndedRef }).pipe(Effect.result);
    expect(Result.isFailure(explicitEnd)).toBe(true);
    if (Result.isFailure(explicitEnd)) {
      expect(Schema.is(CustomerPaymentTermsActionRejected)(explicitEnd.failure)).toBe(true);
      if (Schema.is(CustomerPaymentTermsActionRejected)(explicitEnd.failure)) {
        expect(explicitEnd.failure.code).toBe('REMOVAL_CONFLICT');
      }
    }
    const proved = yield* Effect.gen(function* retainedIntentRollbackAndRace() {
      const untouched = yield* retainedLegacyRows();
      const evidenceBefore = yield* fixture.evidence(coreEvidenceExecutor);
      fixture.faultNextTransaction('rollback');
      const rolledBack = yield* executeRemoval(legacyPayload).pipe(Effect.result);
      expect(Result.isFailure(rolledBack)).toBe(true);
      expect(yield* retainedLegacyRows()).toEqual(untouched);
      const afterRollback = yield* fixture.evidence(coreEvidenceExecutor);
      expect(afterRollback.events).toHaveLength(evidenceBefore.events.length);
      expect(afterRollback.outbox).toHaveLength(evidenceBefore.outbox.length);
      const attempts = ['2029-01-01T00:00:00.000Z', '2029-02-01T00:00:00.000Z'].map((effectiveAt) => ({
        key: randomUUID(),
        payload: { ...legacyPayload, effectiveAt },
      }));
      const raced = yield* Effect.all(
        attempts.map((attempt) => executeRemoval(attempt.payload, attempt.key).pipe(Effect.result)),
        { concurrency: 2 },
      );
      const successes = raced.filter(Result.isSuccess);
      const failures = raced.filter(Result.isFailure);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      const [winner] = successes;
      const [loser] = failures;
      if (winner === undefined || loser === undefined) {
        return yield* Effect.die('Missing retained-intent race result');
      }
      expect(Schema.is(CustomerPaymentTermsActionRejected)(loser.failure)).toBe(true);
      if (Schema.is(CustomerPaymentTermsActionRejected)(loser.failure)) {
        expect(loser.failure.code).toBe('REVISION_CONFLICT');
      }
      const evidenceAfter = yield* fixture.evidence(coreEvidenceExecutor);
      expect(evidenceAfter.events).toHaveLength(evidenceBefore.events.length + 1);
      expect(evidenceAfter.outbox).toHaveLength(evidenceBefore.outbox.length + 1);
      yield* Effect.gen(function* recoveredLegacyReplay() {
        const cancelledAt = winner.success.state.entitlements.find(
          (entry) => entry.entitlementRef.resourceId === entitlementRef.resourceId,
        )?.cancelledAt;
        const committedAttempt = attempts.find((attempt) => attempt.payload.effectiveAt === cancelledAt);
        if (committedAttempt === undefined) {
          return yield* Effect.die('Missing committed legacy cancellation key');
        }
        const replay = yield* executeRemoval(committedAttempt.payload, committedAttempt.key).pipe(Effect.result);
        expect(Result.isFailure(replay)).toBe(true);
        if (Result.isFailure(replay)) {
          expect(Predicate.isTagged(replay.failure, 'ActionAlreadyCommitted')).toBe(true);
        }
        const equivalent = yield* executeRemoval({
          ...committedAttempt.payload,
          expectedRevision: winner.success.state.revision,
        });
        expect(equivalent).toMatchObject({ changed: false, removalKind: 'CANCELLED', state: winner.success.state });
        const unchanged = yield* fixture.evidence(coreEvidenceExecutor);
        expect(unchanged.events).toHaveLength(evidenceAfter.events.length);
        expect(unchanged.outbox).toHaveLength(evidenceAfter.outbox.length);
        return true;
      });
      return winner.success;
    });
    expect(proved.changed).toBe(true);
    const provedEntitlement = proved.state.entitlements.find(
      (entry) => entry.entitlementRef.resourceId === entitlementRef.resourceId,
    );
    expect(provedEntitlement).toMatchObject({ originalEffectiveTo: grant.effectiveTo, status: 'CANCELLED' });
    expect(['2029-01-01T00:00:00.000Z', '2029-02-01T00:00:00.000Z']).toContain(provedEntitlement?.cancelledAt);
    baseline = proved.state.revision;
    const openRemoved = yield* executeRemoval({
      ...legacyPayload,
      entitlementRef: legacyOpenRef,
      expectedRevision: baseline,
    });
    expect(openRemoved.changed).toBe(true);
    expect(
      openRemoved.state.entitlements.find((entry) => entry.entitlementRef.resourceId === legacyOpenRef.resourceId),
    ).toMatchObject({ cancelledAt: legacyPayload.effectiveAt, originalEffectiveTo: null, status: 'CANCELLED' });
    baseline = openRemoved.state.revision;
  }
  const produced = yield* executeChange(
    [{ ...grant, entitlementRef: freshRef, paymentTermRef: freshTerm, semanticRevisionId: freshTerm.resourceId }],
    baseline,
  );
  expect(
    produced.state.entitlements.find((value) => value.entitlementRef.resourceId === freshRef.resourceId)
      ?.originalEffectiveTo,
  ).toBe(grant.effectiveTo);
  const transport = {
    correlationId: randomUUID(),
    idempotencyKey: randomUUID(),
    targetModuleKey: 'commerce.customer-context',
  } as const;
  const payload = {
    counterpartyRef,
    effectiveAt: '2029-01-01T00:00:00.000Z',
    entitlementRef: freshRef,
    expectedRevision: produced.state.revision,
    profileRef,
    reason: 'Native finite cancellation',
  };
  const cancelled = yield* runAction({
    payload,
    principal,
    registration: removeCustomerPaymentTermAction,
    transport,
  }).pipe(Effect.provideContext(context));
  expect(cancelled.removalKind).toBe('CANCELLED');
  expect(cancelled.changed).toBe(true);
  const replay = yield* runAction({
    payload,
    principal,
    registration: removeCustomerPaymentTermAction,
    transport,
  }).pipe(Effect.provideContext(context), Effect.result);
  expect(Result.isFailure(replay)).toBe(true);
  if (Result.isFailure(replay)) {
    expect(Predicate.isTagged(replay.failure, 'ActionAlreadyCommitted')).toBe(true);
  }
  const equivalent = yield* runAction({
    payload: { ...payload, expectedRevision: cancelled.state.revision },
    principal,
    registration: removeCustomerPaymentTermAction,
    transport: { ...transport, idempotencyKey: randomUUID() },
  }).pipe(Effect.provideContext(context));
  expect(equivalent.changed).toBe(false);
  expect(equivalent.state).toEqual(cancelled.state);
  const saved = cancelled.state.entitlements.find((value) => value.entitlementRef.resourceId === freshRef.resourceId);
  expect(saved).toMatchObject({
    cancelledAt: payload.effectiveAt,
    effectiveTo: grant.effectiveTo,
    originalEffectiveTo: grant.effectiveTo,
    status: 'CANCELLED',
  });
  for (const asOf of [grant.effectiveFrom, '2030-03-01T00:00:00.000Z', grant.effectiveTo]) {
    const view = yield* Context.get(context, ReadRuntime)
      .runRead({
        input: {
          asOf,
          authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
          includeHistorical: true,
          profileRef,
        },
        principal,
        registration: customerPaymentTermEntitlementReadRead,
        transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
      })
      .pipe(Effect.provideContext(context));
    expect(Predicate.isTagged(view, 'CUSTOMER_PAYMENT_TERMS')).toBe(true);
    if (Predicate.isTagged(view, 'CUSTOMER_PAYMENT_TERMS')) {
      expect(view.state.entitlements.some((value) => value.entitlementRef.resourceId === freshRef.resourceId)).toBe(
        false,
      );
    }
  }
  expect(requests).toBeGreaterThan(0);
  const evidence = yield* fixture.evidence(coreEvidenceExecutor);
  expect(evidence.invocations.filter((invocation) => invocation.status === 'succeeded').length).toBeGreaterThanOrEqual(
    2,
  );
  expect(
    evidence.events.some((event) => event.eventType === 'commerce.customer-context.customer-payment-term-removed.v1'),
  ).toBe(true);
  expect(evidence.outbox.length).toBeGreaterThanOrEqual(2);
  const removalEvents = evidence.events.filter(
    (event) =>
      event.eventType === 'commerce.customer-context.customer-payment-term-removed.v1' &&
      event.subjectResourceId === freshRef.resourceId,
  );
  expect(removalEvents).toHaveLength(1);
  const [removalEvent] = removalEvents;
  expect(removalEvent?.payloadJson).toEqual({
    effectiveAt: payload.effectiveAt,
    entitlementRef: freshRef,
    preferenceCleared: false,
    profileRef,
    removalKind: 'CANCELLED',
    revision: cancelled.state.revision,
  });
  expect(
    evidence.audits.some(
      (audit) =>
        audit.actionInvocationId === removalEvent?.actionInvocationId &&
        audit.principalId === fixture.manager.principalId &&
        audit.outcome === 'succeeded',
    ),
  ).toBe(true);
  expect(evidence.outbox.filter((message) => message.domainEventId === removalEvent?.domainEventId)).toHaveLength(1);

  const [native] = yield* admin.execute<{
    readonly cancellation: string;
    readonly known: boolean;
    readonly original: string;
    readonly recordedSeparately: boolean;
  }>(
    sql`select grant_schedule_known as known, to_char(original_effective_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as original, to_char(cancelled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as cancellation, recorded_at <> cancelled_at as "recordedSeparately" from commerce_customer_context.customer_payment_term_entitlements where customer_payment_term_entitlement_id=${freshRef.resourceId}::uuid`,
    'objects',
  );
  expect(native).toEqual({
    cancellation: payload.effectiveAt,
    known: true,
    original: grant.effectiveTo,
    recordedSeparately: true,
  });
  const observeOwner = () =>
    admin.execute<{ readonly snapshot: string }>(
      sql`select coalesce(jsonb_agg(to_jsonb(e) order by customer_payment_term_entitlement_id),'[]'::jsonb)::text as snapshot from commerce_customer_context.customer_payment_term_entitlements e where tenant_id=${fixture.tenantId}::uuid`,
      'objects',
    );
  const endedState = yield* Effect.gen(function* currentFiniteEndControls() {
    const endRef = { ...freshRef, resourceId: randomUUID() };
    const term = { ...freshTerm, resourceId: randomUUID() };
    const currentGrant = {
      ...grant,
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      effectiveTo: '2090-06-01T00:00:00.000Z',
      entitlementRef: endRef,
      paymentTermRef: term,
      semanticRevisionId: term.resourceId,
    };
    const granted = yield* executeChange([currentGrant], equivalent.state.revision);
    const [clock] = yield* admin.execute<{ readonly at: string }>(
      sql`select to_char(transaction_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`,
      'objects',
    );
    const request = {
      ...payload,
      effectiveAt: clock.at,
      entitlementRef: endRef,
      expectedRevision: granted.state.revision,
    };
    const current = yield* Context.get(context, ReadRuntime)
      .runRead({
        input: {
          asOf: clock.at,
          authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
          includeHistorical: false,
          profileRef,
        },
        principal,
        registration: customerPaymentTermEntitlementReadRead,
        transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
      })
      .pipe(Effect.provideContext(context));
    expect(Predicate.isTagged(current, 'CUSTOMER_PAYMENT_TERMS')).toBe(true);
    if (Predicate.isTagged(current, 'CUSTOMER_PAYMENT_TERMS')) {
      expect(current.currentEntitlements.some((value) => value.entitlementRef.resourceId === endRef.resourceId)).toBe(
        true,
      );
    }
    const ended = yield* executeRemoval(request);
    expect(ended.removalKind).toBe('ENDED');
    expect(
      ended.state.entitlements.find((value) => value.entitlementRef.resourceId === endRef.resourceId),
    ).toMatchObject({
      effectiveTo: request.effectiveAt,
      endedAt: request.effectiveAt,
      originalEffectiveTo: currentGrant.effectiveTo,
    });
    const endReplay = yield* executeRemoval({ ...request, expectedRevision: ended.state.revision });
    expect(endReplay.changed).toBe(false);
    expect(endReplay.state).toEqual(ended.state);
    const conflict = yield* executeRemoval({
      ...request,
      effectiveAt: '2030-04-01T00:00:00.000Z',
      expectedRevision: ended.state.revision,
    }).pipe(Effect.result);
    expect(Result.isFailure(conflict)).toBe(true);
    if (Result.isFailure(conflict)) {
      expect(Schema.is(CustomerPaymentTermsActionRejected)(conflict.failure)).toBe(true);
      if (Schema.is(CustomerPaymentTermsActionRejected)(conflict.failure)) {
        expect(conflict.failure.code).toBe('REMOVAL_CONFLICT');
      }
    }
    const [stored] = yield* admin.execute<{
      readonly effective: string;
      readonly ended: string;
      readonly original: string;
    }>(
      sql`select to_char(effective_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective, to_char(original_effective_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as original, to_char(ended_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ended from commerce_customer_context.customer_payment_term_entitlements where customer_payment_term_entitlement_id=${endRef.resourceId}::uuid`,
      'objects',
    );
    expect(stored).toEqual({
      effective: request.effectiveAt,
      ended: request.effectiveAt,
      original: currentGrant.effectiveTo,
    });
    return ended.state;
  });
  const rolledBackState = yield* Effect.gen(function* cancellationRollbackControls() {
    const rollbackRef = { ...freshRef, resourceId: randomUUID() };
    const term = { ...freshTerm, resourceId: randomUUID() };
    const granted = yield* executeChange(
      [{ ...grant, entitlementRef: rollbackRef, paymentTermRef: term, semanticRevisionId: term.resourceId }],
      endedState.revision,
    );
    const request = { ...payload, entitlementRef: rollbackRef, expectedRevision: granted.state.revision };
    const before = yield* observeOwner();
    const evidenceBefore = yield* fixture.evidence(coreEvidenceExecutor);
    fixture.faultNextTransaction('rollback');
    const failed = yield* executeRemoval(request).pipe(Effect.result);
    expect(Result.isFailure(failed)).toBe(true);
    expect(yield* observeOwner()).toEqual(before);
    const evidenceAfter = yield* fixture.evidence(coreEvidenceExecutor);
    expect(evidenceAfter.events).toHaveLength(evidenceBefore.events.length);
    expect(evidenceAfter.outbox).toHaveLength(evidenceBefore.outbox.length);
    const committed = yield* executeRemoval(request);
    expect(committed.changed).toBe(true);
    expect(committed.removalKind).toBe('CANCELLED');
    return committed.state;
  });
  const raceState = yield* Effect.gen(function* cancellationConcurrentCasControls() {
    const raceRef = { ...freshRef, resourceId: randomUUID() };
    const term = { ...freshTerm, resourceId: randomUUID() };
    const granted = yield* executeChange(
      [{ ...grant, entitlementRef: raceRef, paymentTermRef: term, semanticRevisionId: term.resourceId }],
      rolledBackState.revision,
    );
    const before = yield* fixture.evidence(coreEvidenceExecutor);
    const raced = yield* Effect.all(
      ['2029-01-01T00:00:00.000Z', '2029-02-01T00:00:00.000Z'].map((effectiveAt) =>
        executeRemoval({
          ...payload,
          effectiveAt,
          entitlementRef: raceRef,
          expectedRevision: granted.state.revision,
        }).pipe(Effect.result),
      ),
      { concurrency: 2 },
    );
    const succeeded = raced.filter(Result.isSuccess);
    const failed = raced.filter(Result.isFailure);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const [winner] = succeeded;
    const [loser] = failed;
    if (winner === undefined || loser === undefined) {
      return yield* Effect.die('Native cancellation race did not produce one winner');
    }
    expect(Schema.is(CustomerPaymentTermsActionRejected)(loser.failure)).toBe(true);
    if (Schema.is(CustomerPaymentTermsActionRejected)(loser.failure)) {
      expect(loser.failure.code).toBe('REVISION_CONFLICT');
    }
    expect(winner.success.state.revision).toBe(granted.state.revision + 1);
    const after = yield* fixture.evidence(coreEvidenceExecutor);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(after.outbox).toHaveLength(before.outbox.length + 1);
    return winner.success.state;
  });
  yield* Effect.gen(function* removalRejectionAndNativeInvariantControls() {
    const before = yield* observeOwner();
    const beforeEvidence = yield* fixture.evidence(coreEvidenceExecutor);
    const controls = [
      { code: 'REVISION_CONFLICT', input: { ...payload, expectedRevision: raceState.revision - 1 } },
      {
        code: 'REMOVAL_CONFLICT',
        input: { ...payload, effectiveAt: '2029-02-01T00:00:00.000Z', expectedRevision: raceState.revision },
      },
      {
        code: 'ENTITLEMENT_NOT_FOUND',
        input: {
          ...payload,
          entitlementRef: { ...freshRef, resourceId: randomUUID() },
          expectedRevision: raceState.revision,
        },
      },
      {
        code: 'PROFILE_NOT_FOUND',
        input: {
          ...payload,
          expectedRevision: raceState.revision,
          profileRef: { ...profileRef, resourceId: randomUUID() },
        },
      },
      {
        code: 'SCOPE_MISMATCH',
        input: {
          ...payload,
          expectedRevision: raceState.revision,
          profileRef: { ...profileRef, tenantId: randomUUID() },
        },
      },
    ];
    for (const control of controls) {
      const failed = yield* executeRemoval(control.input).pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      if (Result.isFailure(failed)) {
        expect(Schema.is(CustomerPaymentTermsActionRejected)(failed.failure)).toBe(true);
        if (Schema.is(CustomerPaymentTermsActionRejected)(failed.failure)) {
          expect(failed.failure.code).toBe(control.code);
        }
      }
    }
    const ownerInput = {
      actionInvocationId: randomUUID(),
      changed: true,
      counterpartyResourceId: counterpartyRef.resourceId,
      expectedRevision: raceState.revision,
      principalId: fixture.manager.principalId,
      profileKind: 'COUNTERPARTY',
      profileResourceId: profileId,
      reason: 'Native invalid provenance control',
    };
    const originalsChanged = {
      ...raceState,
      entitlements: raceState.entitlements.map((value) =>
        value.entitlementRef.resourceId === freshRef.resourceId
          ? { ...value, originalEffectiveTo: '2030-07-01T00:00:00.000Z' }
          : value,
      ),
      revision: raceState.revision + 1,
    };
    const immutable = yield* fixture
      .prepareOwner(
        (transaction) => transaction.invoke(persist, [{ ...ownerInput, state: originalsChanged }]),
        'required',
      )
      .pipe(Effect.provideContext(context), Effect.result);
    expectSqlRejection(immutable, '22023');
    const malformed = {
      ...raceState,
      entitlements: [
        ...raceState.entitlements,
        {
          cancelledAt: '2031-01-01T00:00:00.000Z',
          effectiveFrom: grant.effectiveFrom,
          effectiveTo: grant.effectiveTo,
          entitlementRef: { ...freshRef, resourceId: randomUUID() },
          originalEffectiveTo: grant.effectiveTo,
          paymentTermRef: freshTerm,
          semanticRevisionId: freshTerm.resourceId,
          status: 'CANCELLED',
        },
      ],
      revision: raceState.revision + 1,
    };
    const invalid = yield* fixture
      .prepareOwner(
        (transaction) =>
          transaction.invoke(persist, [{ ...ownerInput, actionInvocationId: randomUUID(), state: malformed }]),
        'required',
      )
      .pipe(Effect.provideContext(context), Effect.result);
    expectSqlRejection(invalid, '23514');
    const missingHistory = {
      ...raceState,
      entitlements: raceState.entitlements.filter((value) => value.entitlementRef.resourceId !== freshRef.resourceId),
      revision: raceState.revision + 1,
    };
    const removedHistory = yield* fixture
      .prepareOwner(
        (transaction) =>
          transaction.invoke(persist, [{ ...ownerInput, actionInvocationId: randomUUID(), state: missingHistory }]),
        'required',
      )
      .pipe(Effect.provideContext(context), Effect.result);
    expectSqlRejection(removedHistory, '22023');
    expect(yield* observeOwner()).toEqual(before);
    const afterEvidence = yield* fixture.evidence(coreEvidenceExecutor);
    expect(afterEvidence.events).toHaveLength(beforeEvidence.events.length);
    expect(afterEvidence.outbox).toHaveLength(beforeEvidence.outbox.length);
  });
  yield* Effect.gen(function* scopedOwnerIsolationControls() {
    const before = yield* observeOwner();
    const evidenceBefore = yield* fixture.evidence(coreEvidenceExecutor);
    const denied = yield* runAction({
      payload: { ...payload, expectedRevision: raceState.revision },
      principal: { ...fixture.denied, legalEntityId: fixture.legalEntityId },
      registration: removeCustomerPaymentTermAction,
      transport: {
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        targetModuleKey: 'commerce.customer-context',
      },
    }).pipe(Effect.provideContext(context), Effect.result);
    expect(Result.isFailure(denied)).toBe(true);
    if (Result.isFailure(denied)) {
      expect(Schema.is(OperationContextDenied)(denied.failure)).toBe(true);
    }
    // This actor has selected-LE membership, but no exact owner permission. Tenant membership
    // can inherit Action execution permission, so this is not an executor-negative claim.
    const ownerDenied = yield* runAction({
      payload: { ...payload, expectedRevision: raceState.revision },
      principal: { ...fixture.legalEntityOnly, legalEntityId: fixture.legalEntityId },
      registration: removeCustomerPaymentTermAction,
      transport: {
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        targetModuleKey: 'commerce.customer-context',
      },
    }).pipe(Effect.provideContext(context), Effect.result);
    expect(Result.isFailure(ownerDenied)).toBe(true);
    if (Result.isFailure(ownerDenied)) {
      expect(Schema.is(ActionPermissionDenied)(ownerDenied.failure)).toBe(true);
    }
    const mismatched = yield* fixture
      .prepareOwner(
        (transaction) => transaction.invoke(readOwner, [profileId, 'COUNTERPARTY', randomUUID()]),
        'required',
      )
      .pipe(Effect.provideContext(context));
    expect(mismatched[0]?.outcome).toBe('PROFILE_COUNTERPARTY_MISMATCH');
    const foreign = yield* Effect.acquireRelease(
      makeLiveOperationFixture({
        actionKeys: [],
        adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
        allowedAudiences: ['commerce-customer-context'],
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        compositionRevision: snapshot.composition.revision,
        moduleKeys: ['commerce.customer-context'],
        runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
      }),
      (resource) => resource.close().pipe(Effect.orDie),
    );
    expect(foreign.tenantId).not.toBe(fixture.tenantId);
    expect(foreign.legalEntityId).not.toBe(fixture.legalEntityId);
    const invisible = yield* foreign
      .prepareOwner(
        (transaction) => transaction.invoke(readOwner, [profileId, 'COUNTERPARTY', counterpartyRef.resourceId]),
        'required',
      )
      .pipe(Effect.provideContext(context));
    expect(invisible[0]).toEqual({ outcome: 'PROFILE_NOT_FOUND', payload: null });
    expect(yield* observeOwner()).toEqual(before);
    const evidenceAfter = yield* fixture.evidence(coreEvidenceExecutor);
    expect(evidenceAfter.events).toHaveLength(evidenceBefore.events.length);
    expect(evidenceAfter.outbox).toHaveLength(evidenceBefore.outbox.length);
  });
  return true;
});

for (const mode of ['schema-only', 'empty'] as const) {
  it.live(
    `preserves finite original schedules and governed cancellation on ${mode} native storage`,
    () => Effect.scoped(scenario(mode)).pipe(Effect.provide(services)),
    60_000,
  );
}
