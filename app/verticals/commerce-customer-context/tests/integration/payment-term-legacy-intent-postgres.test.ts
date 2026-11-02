import { randomUUID } from 'node:crypto';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { defineScopedRoutine, ScopedRoutineInvocationError } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { Effect, FileSystem, Layer, Option, Path, Redacted, Result, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { enrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
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

const resolveIntent = defineScopedRoutine({
  name: 'resolve_legacy_payment_term_grant_intent_v1',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'integer' },
  ],
  resultSchema: row,
  routineKey: 'test.legacy-intent.resolve',
  schema: 'commerce_customer_context',
});
const privateIntent = defineScopedRoutine({
  name: 'legacy_payment_term_grant_intent_v1',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'integer' },
  ],
  resultSchema: row,
  routineKey: 'test.legacy-intent.private-denied',
  schema: 'commerce_customer_context',
});
// Actual CLI/full immutable journal. Child-only configuration never changes the source database.
const migrateOwner = Effect.fn('FiniteEntitlement.migrateOwner')(function* migrateOwner(
  connections: {
    readonly admin: { readonly connectionString: string };
    readonly runtime: { readonly connectionString: string };
  },
  command: 'migrate' | 'verify' = 'migrate',
  beforeFiniteForward = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-payment-entitlement-' });
  const history = new URL('../../drizzle/', import.meta.url).pathname;
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
        ONTOS_CCC_ENTITLEMENT_MIGRATIONS: migrations,
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

it.live(
  'denies unrecorded legacy provenance, forged schedules and private proof execution',
  () =>
    Effect.scoped(
      Effect.gen(function* missingRetainedIntent() {
        const snapshot = yield* enrollmentApplicationCompositionSnapshot;
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'stabilization-1229-payment-entitlement',
        });
        yield* isolated.migrateCoreSchema();
        yield* isolated.publishInitialComposition(snapshot);
        yield* migrateOwner(isolated.connections, 'migrate', true);
        const fixture = yield* Effect.acquireRelease(
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
        const context = yield* Layer.build(fixture.layer);
        const counterpartyId = randomUUID();
        const [created] = yield* fixture
          .prepareOwner(
            (transaction) =>
              transaction.invoke(ensureProfile, [
                counterpartyId,
                null,
                randomUUID(),
                'native-role-revision',
                '2020-01-01T00:00:00.000Z',
                'AUTHORIZED_ONBOARDING',
                randomUUID(),
                fixture.manager.principalId,
              ]),
            'required',
          )
          .pipe(Effect.provideContext(context));
        if (created === undefined) {
          return yield* Effect.die('Missing native owner profile');
        }
        const profile = yield* Schema.decodeUnknownEffect(ProfileSchema)(created.payload);
        const profileId = profile.profileRef.resourceId;
        const profileRef = {
          moduleId: 'commerce.customer-context',
          resourceId: profileId,
          resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
          tenantId: fixture.tenantId,
        } as const;
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
        const entitlement = {
          effectiveFrom: '2030-01-01T00:00:00.000Z',
          effectiveTo: '2030-06-01T00:00:00.000Z',
          entitlementRef,
          paymentTermRef,
          semanticRevisionId: randomUUID(),
          status: 'ACTIVE' as const,
        };
        const state = { entitlements: [entitlement], preferences: [], profileRef, revision: 2 };
        const attribution = {
          actionInvocationId: randomUUID(),
          changed: true,
          counterpartyResourceId: counterpartyId,
          expectedRevision: 1,
          principalId: fixture.manager.principalId,
          profileKind: 'COUNTERPARTY',
          profileResourceId: profileId,
          reason: 'Native unrecorded owner guard fixture',
          state,
        };
        // Intentionally owner-native, without a Core committed Change event. This is a
        // no-evidence guard fixture, never represented as an original public producer.
        yield* fixture
          .prepareOwner((transaction) => transaction.invoke(persist, [attribution]), 'required')
          .pipe(Effect.provideContext(context));
        yield* migrateOwner(isolated.connections);
        yield* migrateOwner(isolated.connections);
        yield* migrateOwner(isolated.connections, 'verify');
        const query = [profileId, counterpartyId, entitlementRef.resourceId, 2] as const;
        const absent = yield* fixture
          .prepareOwner((transaction) => transaction.invoke(resolveIntent, query), 'required')
          .pipe(Effect.provideContext(context));
        expect(absent).toMatchObject([{ outcome: 'UNPROVED', payload: null }]);
        const wrong = yield* fixture
          .prepareOwner(
            (transaction) => transaction.invoke(resolveIntent, [profileId, randomUUID(), entitlementRef.resourceId, 2]),
            'required',
          )
          .pipe(Effect.provideContext(context));
        expect(wrong).toMatchObject([{ outcome: 'UNPROVED', payload: null }]);
        const guessed = {
          ...entitlement,
          cancelledAt: '2029-01-01T00:00:00.000Z',
          originalEffectiveTo: entitlement.effectiveTo,
          status: 'CANCELLED',
        };
        const forged = yield* fixture
          .prepareOwner(
            (transaction) =>
              transaction.invoke(persist, [
                {
                  ...attribution,
                  actionInvocationId: randomUUID(),
                  expectedRevision: 2,
                  state: { ...state, entitlements: [guessed], revision: 3 },
                },
              ]),
            'required',
          )
          .pipe(Effect.provideContext(context), Effect.result);
        expectSqlRejection(forged, '22023');
        expect(
          yield* fixture
            .prepareOwner((transaction) => transaction.invoke(resolveIntent, query), 'required')
            .pipe(Effect.provideContext(context)),
        ).toEqual(absent);
        const privateDenied = yield* fixture
          .prepareOwner(
            (transaction) => transaction.invoke(privateIntent, [profileId, entitlementRef.resourceId, 2]),
            'required',
          )
          .pipe(Effect.provideContext(context), Effect.result);
        expectSqlRejection(privateDenied, '42501');
        return true;
      }),
    ).pipe(Effect.provide(services)),
  60_000,
);
