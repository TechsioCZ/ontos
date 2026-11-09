import { TrustedPrincipalContextSchema, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { OperationContextUnavailable, OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq, inArray } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import type { SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { symmyImportJobs, symmyIntegrationRelations, symmyJobRoutes } from '../../src/db/schema.ts';
import { SymmyJobStoreError, symmyJobStoreFactory } from '../../src/persistence/symmy-job-store.ts';

const fixtureScope = (tenantId: string, principalId: string, legalEntityId: string): OperationalScope => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: crypto.randomUUID(),
    authContextRef: 'better-auth-api-key:internal-fixture-reference',
    authMethod: 'api_key',
    legalEntityId,
    principalId,
    tenantId,
  }),
  audience: 'symmy-integration',
  correlationId: 'internal-fixture-storage-test',
});

const openDatabase = (connectionString: string) =>
  PgClient.makeClient({ url: Redacted.make(connectionString) }).pipe(
    Effect.flatMap((client) =>
      makeWithDefaults({ relations: symmyIntegrationRelations }).pipe(Effect.provideService(PgClient.PgClient, client)),
    ),
  );

type Store = Effect.Success<ReturnType<typeof symmyJobStoreFactory>>;

// Each call builds a separate pool and transaction, so retries cannot rely on in-process state.
const withScopedStore = <A, E>(
  connectionString: string,
  scope: OperationalScope,
  run: (store: Store) => Effect.Effect<A, E>,
) =>
  openDatabase(connectionString).pipe(
    Effect.flatMap((database) =>
      database.transaction((transaction) =>
        installOperationalScope(transaction, scope).pipe(
          Effect.flatMap((executor) => symmyJobStoreFactory(executor, scope)),
          Effect.flatMap(run),
        ),
      ),
    ),
    Effect.scoped,
  );

type NativeStoreFailure = OperationContextUnavailable | SqlError | SymmyJobStoreError;

const expectJobStoreError = (error: NativeStoreFailure, code: SymmyJobStoreError['code']) => {
  expect(Schema.is(SymmyJobStoreError)(error)).toBe(true);
  expect(error).toMatchObject({ code });
};

it.effect('retains one exact scoped job across concurrent admission, lost response, and new database sessions', () =>
  Effect.gen(function* verifyDurableAdmission() {
    // This lower-level proof starts with Core's database scope; owner HTTP separately proves authentication and permissions.
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const admin = yield* openDatabase(connections.admin.connectionString);
    const principalId = crypto.randomUUID();
    const legalEntityId = crypto.randomUUID();
    const tenantId = crypto.randomUUID();
    const otherTenantId = crypto.randomUUID();
    const routeId = crypto.randomUUID();
    const owner = fixtureScope(tenantId, principalId, legalEntityId);
    const otherPrincipal = fixtureScope(tenantId, crypto.randomUUID(), legalEntityId);
    const otherLegalEntity = fixtureScope(tenantId, principalId, crypto.randomUUID());
    const otherTenant = fixtureScope(otherTenantId, principalId, legalEntityId);
    yield* Effect.addFinalizer(() =>
      admin
        .delete(symmyImportJobs)
        .where(inArray(symmyImportJobs.tenantId, [tenantId, otherTenantId]))
        .pipe(
          Effect.andThen(
            admin.delete(symmyJobRoutes).where(inArray(symmyJobRoutes.tenantId, [tenantId, otherTenantId])),
          ),
          Effect.orDie,
        ),
    );
    const routes = {
      active: true,
      fixtureIds: ['internal-product-example', 'internal-conflicting-example'],
      legalEntityId,
      mappingVersion: 'mapping-v1',
      principalId,
      routeKey: 'productsBatch' as const,
      routeRevision: 'route-v1',
    };
    yield* admin.insert(symmyJobRoutes).values([
      { ...routes, routeId, tenantId },
      { ...routes, tenantId: otherTenantId },
      { ...routes, routeCode: 'internal-eu', routeKey: 'priceListPricesBatch', tenantId },
    ]);

    const scoped = <A, E>(scope: OperationalScope, run: (store: Store) => Effect.Effect<A, E>) =>
      withScopedStore(connections.runtime.connectionString, scope, run);
    const request = {
      fixtureId: 'internal-product-example',
      idempotencyKey: 'internal-test-key',
      routeKey: 'productsBatch' as const,
    };
    const admissions = yield* Effect.all(
      [scoped(owner, (store) => store.admit(request)), scoped(owner, (store) => store.admit(request))],
      { concurrency: 2 },
    );
    const [accepted, repeated] = admissions;
    expect(repeated.jobId).toBe(accepted.jobId);
    expect(admissions.filter(({ inserted }) => inserted)).toHaveLength(1);
    expect(admissions.every(({ executionReady }) => !executionReady)).toBe(true);
    expect(accepted.phase).toBe('admitted');
    const receipt = { jobId: accepted.jobId, phase: accepted.phase };
    expect(yield* scoped(owner, (store) => store.poll(accepted.jobId))).toEqual(Option.some(receipt));
    for (const caller of [otherPrincipal, otherLegalEntity, otherTenant]) {
      expect(yield* scoped(caller, (store) => store.poll(accepted.jobId))).toEqual(Option.none());
    }
    const wrongActor = yield* scoped(otherPrincipal, (store) => store.admit(request)).pipe(Effect.flip);
    expectJobStoreError(wrongActor, 'route_denied');
    const conflict = yield* scoped(owner, (store) =>
      store.admit({ ...request, fixtureId: 'internal-conflicting-example' }),
    ).pipe(Effect.flip);
    expectJobStoreError(conflict, 'idempotency_conflict');

    yield* admin
      .update(symmyJobRoutes)
      .set({ fixtureIds: ['internal-conflicting-example'], mappingVersion: 'mapping-v2', routeRevision: 'route-v2' })
      .where(eq(symmyJobRoutes.routeId, routeId));
    // Withdrawing the fixture denies a new admission attempt even when the original job remains durable.
    const freshOwner = fixtureScope(tenantId, principalId, legalEntityId);
    const withdrawnFixture = yield* scoped(freshOwner, (store) => store.admit(request)).pipe(Effect.flip);
    expectJobStoreError(withdrawnFixture, 'route_denied');
    yield* admin
      .update(symmyJobRoutes)
      .set({ fixtureIds: routes.fixtureIds })
      .where(eq(symmyJobRoutes.routeId, routeId));
    // Once enrollment is restored, a fresh session recovers the original receipt without rewriting its pin.
    expect(yield* scoped(freshOwner, (store) => store.admit(request))).toEqual({
      ...receipt,
      executionReady: false,
      inserted: false,
    });
    const originalRows = yield* admin.select().from(symmyImportJobs).where(eq(symmyImportJobs.tenantId, tenantId));
    expect(originalRows).toHaveLength(1);
    expect(originalRows[0]).toMatchObject({
      fixtureId: request.fixtureId,
      jobId: accepted.jobId,
      legalEntityId,
      mappingVersion: 'mapping-v1',
      principalId,
      routeId,
      routeRevision: 'route-v1',
    });
    expect(JSON.stringify(originalRows)).not.toContain(request.idempotencyKey);
    yield* admin
      .update(symmyJobRoutes)
      .set({ fixtureIds: ['internal-conflicting-example'] })
      .where(eq(symmyJobRoutes.routeId, routeId));

    const next = yield* scoped(owner, (store) =>
      store.admit({ ...request, fixtureId: 'internal-conflicting-example', idempotencyKey: 'internal-next-key' }),
    );
    expect(next.jobId).not.toBe(accepted.jobId);
    const foreign = yield* scoped(otherTenant, (store) => store.admit(request));
    expect(foreign.jobId).not.toBe(accepted.jobId);
    const selected = { ...request, code: 'internal-eu', routeKey: 'priceListPricesBatch' as const };
    const selectedJob = yield* scoped(owner, (store) => store.admit(selected));
    expect(selectedJob.jobId).not.toBe(accepted.jobId);
    const wrongCode = yield* scoped(owner, (store) => store.admit({ ...selected, code: 'internal-foreign' })).pipe(
      Effect.flip,
    );
    expectJobStoreError(wrongCode, 'route_denied');
    const unavailableFixture = yield* scoped(owner, (store) =>
      store.admit({ ...request, idempotencyKey: 'internal-denied-key' }),
    ).pipe(Effect.flip);
    expectJobStoreError(unavailableFixture, 'route_denied');

    yield* admin.update(symmyJobRoutes).set({ active: false }).where(eq(symmyJobRoutes.routeId, routeId));
    const disabled = yield* scoped(owner, (store) => store.admit(request)).pipe(Effect.flip);
    expectJobStoreError(disabled, 'route_denied');
    // Separately authorized read remains usable for work already admitted before route revocation.
    expect(yield* scoped(owner, (store) => store.poll(accepted.jobId))).toEqual(Option.some(receipt));
    const unscoped = yield* openDatabase(connections.runtime.connectionString).pipe(
      Effect.flatMap((database) => database.select().from(symmyImportJobs)),
      Effect.scoped,
    );
    expect(unscoped).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);
