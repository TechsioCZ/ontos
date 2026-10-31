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
  ConfigProvider,
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
import type { CustomerPaymentTermEntitlementRef } from '../../shared/resources/customer-payment-term-entitlement.ts';
import type { PaymentTermReference } from '../../shared/domain/payment-term-contracts.ts';
import type { RemoveCustomerPaymentTermPayload } from '../../shared/actions/remove-customer-payment-term.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { PaymentTermCatalogGatewayCredentialService } from '../../shared/domain/payment-term-catalog-gateway-credential.ts';
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

const journalFingerprint = Effect.fn('PreferencePeriod.journalFingerprint')(function* journalFingerprint(connection: {
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
      "set time zone 'UTC'; select md5(coalesce(jsonb_agg(to_jsonb(journal) order by to_jsonb(journal)::text)::text,'[]')) from drizzle.__drizzle_migrations_commerce_customer_context journal",
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
const copyOwnerBookkeeping = Effect.fn('PreferencePeriod.copyOwnerBookkeeping')(
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
        'drizzle.__drizzle_migrations_commerce_customer_context',
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
const migrateOwner = Effect.fn('PreferencePeriod.migrateOwner')(function* migrateOwner(
  connections: {
    readonly admin: { readonly connectionString: string };
    readonly runtime: { readonly connectionString: string };
  },
  command: 'migrate' | 'verify' = 'migrate',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-payment-entitlement-' });
  const configuration = path.join(directory, 'drizzle.config.mjs');
  yield* fs.writeFileString(
    configuration,
    `export default { dialect:'postgresql', out:process.env.ONTOS_CCC_ENTITLEMENT_MIGRATIONS, schema:process.env.ONTOS_CCC_ENTITLEMENT_SCHEMA, dbCredentials:{url:process.env.DATABASE_ADMIN_URL}, migrations:{schema:'drizzle',table:'__drizzle_migrations_commerce_customer_context'} };`,
  );
  const child = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      '--filter',
      '@app/commerce-customer-context',
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
        ONTOS_CCC_ENTITLEMENT_MIGRATIONS: new URL('../../drizzle/', import.meta.url).pathname,
        ONTOS_CCC_ENTITLEMENT_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
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

const at = (month: string) => `2027-${month}-01T00:00:00.000Z`;

const grant = (
  entitlementRef: CustomerPaymentTermEntitlementRef,
  effectiveFrom: string,
  effectiveTo: string | undefined,
  paymentTerm: PaymentTermReference,
) => {
  const base = {
    _tag: 'GRANT_ENTITLEMENT' as const,
    effectiveFrom,
    entitlementRef,
    paymentTermRef: paymentTerm,
    semanticRevisionId: paymentTerm.resourceId,
  };
  return effectiveTo === undefined ? base : { ...base, effectiveTo };
};
const preference = (effectiveFrom: string, effectiveTo: string | undefined, paymentTerm: PaymentTermReference) => {
  const base = { _tag: 'SET_PREFERENCE' as const, effectiveFrom, paymentTermRef: paymentTerm };
  return effectiveTo === undefined ? base : { ...base, effectiveTo };
};

const scenario = Effect.fn('PreferencePeriod.nativeScenario')(function* nativeScenario() {
  const snapshot = yield* enrollmentApplicationCompositionSnapshot;
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1230-preference-period',
  });
  yield* isolated.assertClonedSchema();
  const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const sourceJournal = yield* journalFingerprint(source.admin);
  const adminServices = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminServices));
  const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
    Effect.provide(adminServices),
  );
  yield* copyOwnerBookkeeping(isolated.connections);
  expect(yield* journalFingerprint(isolated.connections.admin)).toBe(sourceJournal);
  yield* migrateOwner(isolated.connections);
  const ownedJournal = yield* journalFingerprint(isolated.connections.admin);
  yield* migrateOwner(isolated.connections);
  expect(yield* journalFingerprint(isolated.connections.admin)).toBe(ownedJournal);
  expect(yield* journalFingerprint(source.admin)).toBe(sourceJournal);
  yield* migrateOwner(isolated.connections, 'verify');
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
  let beforeCatalogResponse: Effect.Effect<void> = Effect.void;
  // Published dependency HTTP fixture: real CCC generated client/factory, not a canonical Payment owner implementation.
  yield* server.serve(
    Effect.gen(function* currentCatalogFixture() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const input = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CurrentPaymentTermsRequestSchema)),
      );
      expect(request.headers.authorization).toBe('Bearer bounded-native-catalog-credential');
      requests += 1;
      yield* beforeCatalogResponse;
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
  const otherCounterpartyRef = { ...counterpartyRef, resourceId: randomUUID() };
  const otherProfileId = yield* fixture
    .prepareOwner(
      (transaction) =>
        Effect.gen(function* secondProfile() {
          const [created] = yield* transaction.invoke(ensureProfile, [
            otherCounterpartyRef.resourceId,
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
            return yield* Effect.die('No second owner Profile result');
          }
          return (yield* Schema.decodeUnknownEffect(ProfileSchema)(created.payload)).profileRef.resourceId;
        }),
      'required',
    )
    .pipe(Effect.provideContext(context));
  const otherProfileRef = { ...profileRef, resourceId: otherProfileId };
  yield* fixture.grantResourceAccess(otherProfileRef, fixture.manager.principalId);
  for (const targetCounterparty of [counterpartyRef, otherCounterpartyRef]) {
    for (const permission of ['counterparty.settings.payment_terms.manage', 'counterparty.profile.read'] as const) {
      const authorizationGrant = {
        permission,
        principal: { principalId: fixture.manager.principalId, tenantId: fixture.tenantId },
        target: {
          counterpartyId: targetCounterparty.resourceId,
          kind: 'counterparty' as const,
          legalEntityId: fixture.legalEntityId,
          tenantId: fixture.tenantId,
        },
      };
      const pending = yield* fixture
        .prepareOwner(
          (transaction) =>
            transaction.invoke(beginGrant, [
              targetCounterparty.resourceId,
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
      yield* business.mutate({ ...authorizationGrant, operation: 'grant' });
      yield* Effect.addFinalizer(() =>
        business.mutate({ ...authorizationGrant, operation: 'revoke' }).pipe(Effect.orDie),
      );
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
  }
  const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
  const primaryTarget = { counterpartyRef, profileRef };
  const executeChange = (
    changes: Parameters<typeof changeCustomerPaymentTerms>[0]['changes'],
    expectedRevision: number,
    target = primaryTarget,
  ) =>
    runAction({
      payload: { changes, ...target, expectedRevision, reason: 'Exact preference period native producer' },
      principal,
      registration: changeCustomerPaymentTermsAction,
      transport: {
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        targetModuleKey: 'commerce.customer-context',
      },
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.orElse(
          ConfigProvider.fromUnknown({ ONTOS_ACTION_TRANSACTION_IO_GUARD: true }),
          ConfigProvider.fromEnv(),
        ),
      ),
      Effect.provideContext(context),
    );
  const executeRemoval = (input: RemoveCustomerPaymentTermPayload, idempotencyKey = randomUUID()) =>
    runAction({
      payload: input,
      principal,
      registration: removeCustomerPaymentTermAction,
      transport: { correlationId: randomUUID(), idempotencyKey, targetModuleKey: 'commerce.customer-context' },
    }).pipe(Effect.provideContext(context));
  const entitlement = () => ({
    moduleId: 'commerce.customer-context' as const,
    resourceId: randomUUID(),
    resourceType: 'commerce.customer-context.customer-payment-term-entitlement' as const,
    tenantId: fixture.tenantId,
  });
  const term = () => ({
    moduleId: 'payment.term-catalog' as const,
    resourceId: randomUUID(),
    resourceType: 'payment.term-catalog.payment-term' as const,
    tenantId: fixture.tenantId,
  });
  const paymentTermRef = term();
  const a = entitlement();
  const b = entitlement();
  const c = entitlement();
  const observePreferences = (id = profileId) =>
    admin.execute<{ readonly count: number; readonly snapshot: string }>(
      sql`select coalesce(jsonb_agg(to_jsonb(p) order by effective_from),'[]'::jsonb)::text as snapshot, count(*)::integer as count from commerce_customer_context.customer_payment_term_preferences p where tenant_id=${fixture.tenantId}::uuid and legal_entity_id=${fixture.legalEntityId}::uuid and customer_profile_id=${id}::uuid`,
      'objects',
    );
  const observeEntitlement = (id: string) =>
    admin.execute<{ readonly snapshot: string }>(
      sql`select to_jsonb(e)::text as snapshot from commerce_customer_context.customer_payment_term_entitlements e where tenant_id=${fixture.tenantId}::uuid and legal_entity_id=${fixture.legalEntityId}::uuid and customer_payment_term_entitlement_id=${id}::uuid`,
      'objects',
    );
  const readAt = (asOf: string, includeHistorical = true) =>
    Context.get(context, ReadRuntime)
      .runRead({
        input: { asOf, authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' }, includeHistorical, profileRef },
        principal,
        registration: customerPaymentTermEntitlementReadRead,
        transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
      })
      .pipe(Effect.provideContext(context));
  const otherTerm = term();
  const otherInitial = yield* executeChange(
    [grant(entitlement(), at('01'), at('06'), otherTerm), preference(at('01'), at('06'), otherTerm)],
    1,
    { counterpartyRef: otherCounterpartyRef, profileRef: otherProfileRef },
  );
  // Change the same owner's state while the first Action waits for Catalog HTTP.
  // The first Action must re-read and reject its stale snapshot before any write.
  const staleEntitlement = entitlement();
  beforeCatalogResponse = Effect.gen(function* changeDuringCatalog() {
    beforeCatalogResponse = Effect.void;
    yield* executeChange([{ _tag: 'CLEAR_PREFERENCE', effectiveAt: at('03') }], otherInitial.state.revision, {
      counterpartyRef: otherCounterpartyRef,
      profileRef: otherProfileRef,
    }).pipe(Effect.orDie);
  });
  const stale = yield* executeChange(
    [grant(staleEntitlement, at('10'), undefined, term())],
    otherInitial.state.revision,
    { counterpartyRef: otherCounterpartyRef, profileRef: otherProfileRef },
  ).pipe(Effect.result);
  expect(Result.isFailure(stale)).toBe(true);
  if (Result.isFailure(stale)) {
    expect(stale.failure).toMatchObject({ code: 'operation_context_unavailable' });
  }
  expect(yield* observeEntitlement(staleEntitlement.resourceId)).toEqual([]);
  const otherBefore = yield* observePreferences(otherProfileId);
  // All intervals are produced through the original governed Change Action and real catalog client.
  const initial = yield* executeChange(
    [
      grant(a, at('01'), at('06'), paymentTermRef),
      grant(b, at('07'), at('09'), paymentTermRef),
      grant(c, at('10'), undefined, paymentTermRef),
      preference(at('01'), at('06'), paymentTermRef),
      preference(at('10'), undefined, paymentTermRef),
    ],
    1,
  );
  const preferencesBefore = yield* observePreferences();
  expect(preferencesBefore[0]?.count).toBe(2);
  const aBefore = yield* observeEntitlement(a.resourceId);
  const cBefore = yield* observeEntitlement(c.resourceId);
  const beforeView = yield* readAt(at('03'));
  const before = yield* fixture.evidence(coreEvidenceExecutor);
  const input = {
    counterpartyRef,
    effectiveAt: at('03'),
    entitlementRef: b,
    expectedRevision: initial.state.revision,
    profileRef,
    reason: 'Cancel only the unrelated future B period',
  };
  const key = randomUUID();
  const removed = yield* executeRemoval(input, key);
  expect(removed).toMatchObject({ changed: true, preferenceCleared: false, removalKind: 'CANCELLED' });
  expect(removed.state.preferences).toEqual(initial.state.preferences);
  expect(yield* observePreferences()).toEqual(preferencesBefore);
  expect(yield* observeEntitlement(a.resourceId)).toEqual(aBefore);
  expect(yield* observeEntitlement(c.resourceId)).toEqual(cBefore);
  expect(yield* observePreferences(otherProfileId)).toEqual(otherBefore);
  const afterView = yield* readAt(at('03'));
  expect(Predicate.isTagged(beforeView, 'CUSTOMER_PAYMENT_TERMS')).toBe(true);
  expect(Predicate.isTagged(afterView, 'CUSTOMER_PAYMENT_TERMS')).toBe(true);
  if (
    Predicate.isTagged(beforeView, 'CUSTOMER_PAYMENT_TERMS') &&
    Predicate.isTagged(afterView, 'CUSTOMER_PAYMENT_TERMS')
  ) {
    expect(afterView.currentPreference).toEqual(beforeView.currentPreference);
    expect(afterView.state.preferences).toEqual(beforeView.state.preferences);
    expect(afterView.state.entitlements).toEqual(beforeView.state.entitlements);
  }
  const eventsAfter = yield* fixture.evidence(coreEvidenceExecutor);
  const events = eventsAfter.events.filter(
    (event) =>
      event.eventType === 'commerce.customer-context.customer-payment-term-removed.v1' &&
      event.subjectResourceId === b.resourceId,
  );
  expect(events).toHaveLength(1);
  const [event] = events;
  expect(event?.payloadJson).toEqual({
    effectiveAt: input.effectiveAt,
    entitlementRef: b,
    preferenceCleared: false,
    profileRef,
    removalKind: 'CANCELLED',
    revision: removed.state.revision,
  });
  expect(
    eventsAfter.audits.some(
      (audit) =>
        audit.actionInvocationId === event?.actionInvocationId &&
        audit.principalId === fixture.manager.principalId &&
        audit.outcome === 'succeeded',
    ),
  ).toBe(true);
  expect(eventsAfter.outbox.filter((message) => message.domainEventId === event?.domainEventId)).toHaveLength(1);
  expect(eventsAfter.events.length).toBe(before.events.length + 1);
  const replay = yield* executeRemoval(input, key).pipe(Effect.result);
  expect(Result.isFailure(replay)).toBe(true);
  if (Result.isFailure(replay)) {
    expect(Predicate.isTagged(replay.failure, 'ActionAlreadyCommitted')).toBe(true);
  }
  const equivalent = yield* executeRemoval({ ...input, expectedRevision: removed.state.revision });
  expect(equivalent).toMatchObject({ changed: false, preferenceCleared: false });
  expect(equivalent.state).toEqual(removed.state);
  expect((yield* fixture.evidence(coreEvidenceExecutor)).events.length).toBe(eventsAfter.events.length);
  expect((yield* fixture.evidence(coreEvidenceExecutor)).outbox.length).toBe(eventsAfter.outbox.length);
  // CAS, different removal schedule, overlapping grants and foreign profile refs are terminal, not partial effects.
  yield* Effect.gen(function* rejectionAndRollbackControls() {
    const stableRows = yield* observePreferences();
    const stableEvidence = yield* fixture.evidence(coreEvidenceExecutor);
    for (const control of [
      { expected: 'REVISION_CONFLICT', payload: input },
      {
        expected: 'REMOVAL_CONFLICT',
        payload: { ...input, effectiveAt: at('04'), expectedRevision: equivalent.state.revision },
      },
      {
        expected: 'PROFILE_NOT_FOUND',
        payload: {
          ...input,
          expectedRevision: equivalent.state.revision,
          profileRef: { ...profileRef, resourceId: randomUUID() },
        },
      },
      {
        expected: 'SCOPE_MISMATCH',
        payload: {
          ...input,
          expectedRevision: equivalent.state.revision,
          profileRef: { ...profileRef, tenantId: randomUUID() },
        },
      },
    ]) {
      const outcome = yield* executeRemoval(control.payload).pipe(Effect.result);
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(Schema.is(CustomerPaymentTermsActionRejected)(outcome.failure)).toBe(true);
        if (Schema.is(CustomerPaymentTermsActionRejected)(outcome.failure)) {
          expect(outcome.failure.code).toBe(control.expected);
        }
      }
    }
    const overlap = yield* executeChange(
      [grant(entitlement(), at('02'), at('04'), paymentTermRef)],
      equivalent.state.revision,
    ).pipe(Effect.result);
    expect(Result.isFailure(overlap)).toBe(true);
    if (Result.isFailure(overlap) && Schema.is(CustomerPaymentTermsActionRejected)(overlap.failure)) {
      expect(overlap.failure.code).toBe('ENTITLEMENT_OVERLAP');
    }
    expect(yield* observePreferences()).toEqual(stableRows);
    expect((yield* fixture.evidence(coreEvidenceExecutor)).events.length).toBe(stableEvidence.events.length);
    expect((yield* fixture.evidence(coreEvidenceExecutor)).outbox.length).toBe(stableEvidence.outbox.length);
    for (const actor of [fixture.denied, fixture.legalEntityOnly]) {
      const denied = yield* runAction({
        payload: { ...input, expectedRevision: equivalent.state.revision },
        principal: { ...actor, legalEntityId: fixture.legalEntityId },
        registration: removeCustomerPaymentTermAction,
        transport: {
          correlationId: randomUUID(),
          idempotencyKey: randomUUID(),
          targetModuleKey: 'commerce.customer-context',
        },
      }).pipe(Effect.provideContext(context), Effect.result);
      expect(Result.isFailure(denied)).toBe(true);
      if (Result.isFailure(denied)) {
        expect(
          actor === fixture.denied
            ? Schema.is(OperationContextDenied)(denied.failure)
            : Schema.is(ActionPermissionDenied)(denied.failure),
        ).toBe(true);
      }
    }
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
      (value) => value.close().pipe(Effect.orDie),
    );
    const foreignRead = yield* foreign
      .prepareOwner(
        (transaction) => transaction.invoke(readOwner, [profileId, 'COUNTERPARTY', counterpartyRef.resourceId]),
        'required',
      )
      .pipe(Effect.provide(foreign.layer));
    expect(foreignRead[0]?.outcome).toBe('PROFILE_NOT_FOUND');
    const invalidCoverage = yield* fixture
      .prepareOwner(
        (transaction) =>
          transaction.invoke(persist, [
            {
              actionInvocationId: randomUUID(),
              changed: true,
              counterpartyResourceId: counterpartyRef.resourceId,
              expectedRevision: equivalent.state.revision,
              principalId: fixture.manager.principalId,
              profileKind: 'COUNTERPARTY',
              profileResourceId: profileId,
              reason: 'Negative whole-period coverage control',
              state: {
                ...equivalent.state,
                preferences: [{ ...equivalent.state.preferences[0], effectiveTo: at('09') }],
                revision: equivalent.state.revision + 1,
              },
            },
          ]),
        'required',
      )
      .pipe(Effect.provideContext(context), Effect.result);
    expectSqlRejection(invalidCoverage, '23514');
    expect(yield* observePreferences()).toEqual(stableRows);
    expect(yield* observeEntitlement(a.resourceId)).toEqual(aBefore);
    expect((yield* fixture.evidence(coreEvidenceExecutor)).events.length).toBe(stableEvidence.events.length);
  });
  // A removal really shortens only its supported preference; C stays scheduled and no replacement is selected.
  const ended = yield* executeRemoval({
    ...input,
    entitlementRef: a,
    expectedRevision: equivalent.state.revision,
    reason: 'End actual A support at the requested instant',
  });
  expect(ended).toMatchObject({ preferenceCleared: true, removalKind: 'ENDED' });
  expect(ended.state.preferences).toEqual([
    { ...initial.state.preferences[0], effectiveTo: at('03') },
    initial.state.preferences[1],
  ]);
  const current = yield* readAt(at('03'), false);
  expect(Predicate.isTagged(current, 'CUSTOMER_PAYMENT_TERMS')).toBe(true);
  if (Predicate.isTagged(current, 'CUSTOMER_PAYMENT_TERMS')) {
    expect(current.currentPreference).toBeUndefined();
  }
  const historical = yield* readAt(at('04'));
  if (Predicate.isTagged(historical, 'CUSTOMER_PAYMENT_TERMS')) {
    expect(historical.state.preferences).toEqual([ended.state.preferences[0]]);
  }
  expect(yield* observePreferences(otherProfileId)).toEqual(otherBefore);
  // Native finite preferences are stored ENDED even before their start. Cancellation must
  // remove them from the effective schedule while retaining the original native audit fact.
  const finiteRef = entitlement();
  const finiteTerm = term();
  const finite = yield* executeChange(
    [grant(finiteRef, at('07'), at('09'), finiteTerm), preference(at('07'), at('09'), finiteTerm)],
    ended.state.revision,
  );
  const [finiteRow] = yield* admin.execute<{ readonly lifecycle: string }>(
    sql`select lifecycle from commerce_customer_context.customer_payment_term_preferences where customer_profile_id=${profileId}::uuid and payment_term_resource_id=${finiteTerm.resourceId} and effective_from=${at('07')}::timestamptz`,
    'objects',
  );
  expect(finiteRow?.lifecycle).toBe('ENDED');
  const finiteRemoved = yield* executeRemoval({
    ...input,
    entitlementRef: finiteRef,
    expectedRevision: finite.state.revision,
    reason: 'Cancel future finite preference supporting period',
  });
  expect(finiteRemoved).toMatchObject({ preferenceCleared: true, removalKind: 'CANCELLED' });
  expect(
    finiteRemoved.state.preferences.some((value) => value.paymentTermRef.resourceId === finiteTerm.resourceId),
  ).toBe(false);
  const [retained] = yield* admin.execute<{ readonly lifecycle: string }>(
    sql`select lifecycle from commerce_customer_context.customer_payment_term_preferences where customer_profile_id=${profileId}::uuid and payment_term_resource_id=${finiteTerm.resourceId} and effective_from=${at('07')}::timestamptz`,
    'objects',
  );
  expect(retained?.lifecycle).toBe('CANCELLED');
  const finalView = yield* readAt(at('08'));
  if (Predicate.isTagged(finalView, 'CUSTOMER_PAYMENT_TERMS')) {
    expect(finalView.state.preferences.some((value) => value.paymentTermRef.resourceId === finiteTerm.resourceId)).toBe(
      false,
    );
  }
  const boundaryRef = entitlement();
  const boundaryTerm = term();
  const boundary = yield* executeChange(
    [grant(boundaryRef, at('01'), at('09'), boundaryTerm), preference(at('05'), at('06'), boundaryTerm)],
    finiteRemoved.state.revision,
  );
  const boundaryRemoval = yield* executeRemoval({
    ...input,
    effectiveAt: at('05'),
    entitlementRef: boundaryRef,
    expectedRevision: boundary.state.revision,
    reason: 'End support at exact finite preference start',
  });
  expect(boundaryRemoval).toMatchObject({ preferenceCleared: true, removalKind: 'ENDED' });
  expect(
    boundaryRemoval.state.preferences.some((value) => value.paymentTermRef.resourceId === boundaryTerm.resourceId),
  ).toBe(false);
  const [boundaryStored] = yield* admin.execute<{ readonly lifecycle: string }>(
    sql`select lifecycle from commerce_customer_context.customer_payment_term_preferences where customer_profile_id=${profileId}::uuid and payment_term_resource_id=${boundaryTerm.resourceId}`,
    'objects',
  );
  expect(boundaryStored?.lifecycle).toBe('CANCELLED');
  yield* Effect.gen(function* sameRevisionRace() {
    const first = entitlement();
    const second = entitlement();
    const raceTerm = term();
    const ready = yield* executeChange(
      [grant(first, at('05'), at('06'), raceTerm), grant(second, at('07'), at('09'), raceTerm)],
      boundaryRemoval.state.revision,
    );
    const rows = yield* observePreferences();
    const evidenceBefore = yield* fixture.evidence(coreEvidenceExecutor);
    const outcomes = yield* Effect.all(
      [first, second].map((entitlementRef) =>
        executeRemoval({
          ...input,
          entitlementRef,
          expectedRevision: ready.state.revision,
          reason: 'Same-revision exact-period race',
        }).pipe(Effect.result),
      ),
      { concurrency: 2 },
    );
    expect(outcomes.filter(Result.isSuccess)).toHaveLength(1);
    expect(outcomes.filter(Result.isFailure)).toHaveLength(1);
    for (const outcome of outcomes) {
      if (Result.isFailure(outcome)) {
        expect(Schema.is(CustomerPaymentTermsActionRejected)(outcome.failure)).toBe(true);
        if (Schema.is(CustomerPaymentTermsActionRejected)(outcome.failure)) {
          expect(outcome.failure.code).toBe('REVISION_CONFLICT');
        }
      }
    }
    expect(yield* observePreferences()).toEqual(rows);
    const evidenceAfter = yield* fixture.evidence(coreEvidenceExecutor);
    expect(evidenceAfter.events.length).toBe(evidenceBefore.events.length + 1);
    expect(evidenceAfter.outbox.length).toBe(evidenceBefore.outbox.length + 1);
  });
  expect(requests).toBeGreaterThan(0);
  expect(yield* journalFingerprint(source.admin)).toBe(sourceJournal);
  return yield* Effect.void;
});

it.live(
  'preserves exact preference periods through governed producers, native persistence and Current history',
  () => Effect.scoped(scenario()).pipe(Effect.provide(services)),
  60_000,
);
