import { sql } from 'drizzle-orm';
import { Cause, Context, Deferred, Effect, Exit, Fiber, Predicate, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { makeOperationalScopeRepository } from '../../src/operations/context.ts';
import type { OperationContextUnavailable } from '../../src/operations/errors.ts';
import type { ReadEvidencePersistenceError } from '../../src/reads/errors.ts';
import { persistScopedReadEvidence } from '../../src/reads/repository.ts';
import { makeTestDatabase } from '../support/database.ts';

const scopedPrincipal = trustVerifiedGatewayPrincipalContext(
  {
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:sql-finalizer',
    authMethod: 'session',
    correlationId: 'sql-finalizer-test',
    principalId: '10000000-0000-4000-8000-000000000001',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  'a'.repeat(64),
  { assertion: Redacted.make('verified-finalizer-test-assertion'), audience: 'party-registry' },
);

for (const boundary of ['context', 'evidence'] as const) {
  const run = (
    executor: CoreDatabaseExecutor,
  ): Effect.Effect<void, OperationContextUnavailable | ReadEvidencePersistenceError> =>
    boundary === 'context'
      ? makeOperationalScopeRepository({ executor }).load(scopedPrincipal).pipe(Effect.asVoid)
      : persistScopedReadEvidence(executor, {
          accessKind: 'list',
          captureMode: 'metadata_only',
          outcome: 'denied',
          outcomeCode: 'permission_denied',
          outcomeStage: 'authz',
          policyKey: 'test.read.v1',
          readKey: 'test.read',
          resultCount: 0,
          scope: scopedPrincipal,
          servingModuleKey: 'core.shell',
        });

  for (const phase of ['BEGIN', 'COMMIT', 'ROLLBACK', 'RELEASE SAVEPOINT', 'ROLLBACK TO SAVEPOINT'] as const) {
    it.effect(`scoped ${boundary} maps native ${phase} failures to its declared persistence error`, () =>
      Effect.gen(function* classifyScopedSettlement() {
        const failure = new SqlError({ reason: new ConnectionError({ cause: new Error(`${phase} failed`) }) });
        const events: string[] = [];
        const executor = yield* makeTestDatabase((statement) => {
          events.push(statement);
          const failingControl = phase.includes('SAVEPOINT') ? statement.startsWith(phase) : statement === phase;
          const failingBody =
            phase.startsWith('ROLLBACK') &&
            (statement.includes('from "core"."tenants"') || statement.startsWith('insert into'));
          if (failingControl || failingBody) {
            return Effect.fail(failure);
          }
          return Effect.succeed(
            statement.includes('trust.')
              ? [{ legal_entity_id: '', role: 'party_registry_runtime', tenant_id: scopedPrincipal.tenantId }]
              : [],
          );
        });
        const error = yield* Effect.flip(
          phase.includes('SAVEPOINT') ? executor.transaction(() => run(executor)) : run(executor),
        );
        expect(
          Predicate.isTagged(
            error,
            boundary === 'context' ? 'OperationContextUnavailable' : 'ReadEvidencePersistenceError',
          ),
        ).toBe(true);
        expect(events.some((statement) => statement.startsWith(phase))).toBe(true);
      }),
    );
  }

  it.effect(`scoped ${boundary} preserves unrelated settlement defects`, () =>
    Effect.gen(function* preserveUnrelatedSettlementDefect() {
      const defect = new Error('unexpected settlement defect');
      const executor = yield* makeTestDatabase((statement) =>
        statement === 'COMMIT'
          ? Effect.die(defect)
          : Effect.succeed(
              statement.includes('trust.')
                ? [{ legal_entity_id: '', role: 'party_registry_runtime', tenant_id: scopedPrincipal.tenantId }]
                : [],
            ),
      );
      const exit = yield* Effect.exit(run(executor));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(true);
      }
    }),
  );

  it.effect(`scoped ${boundary} preserves unrelated rollback defects beside promoted SQL failures`, () =>
    Effect.gen(function* preserveUnrelatedRollbackDefect() {
      const defect = new Error('unexpected rollback defect');
      const sqlFailure = new SqlError({ reason: new ConnectionError({ cause: new Error('body query failed') }) });
      const events: string[] = [];
      const executor = yield* makeTestDatabase((statement) => {
        events.push(statement);
        if (statement === 'ROLLBACK') {
          return Effect.die(defect);
        }
        if (statement.includes('from "core"."tenants"') || statement.startsWith('insert into')) {
          return Effect.fail(sqlFailure);
        }
        return Effect.succeed(
          statement.includes('trust.')
            ? [{ legal_entity_id: '', role: 'party_registry_runtime', tenant_id: scopedPrincipal.tenantId }]
            : [],
        );
      });
      const exit = yield* Effect.exit(run(executor));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(true);
      }
      expect(events).toContain('ROLLBACK');
    }),
  );
}

const harness = Effect.fn(function* makeHarness(
  settle: (statement: string) => Effect.Effect<void, SqlError> = () => Effect.void,
) {
  const events: string[] = [];
  const executor = yield* makeTestDatabase((statement) =>
    Effect.gen(function* execute() {
      events.push(statement);
      yield* settle(statement);
      return [];
    }),
  );
  return { events, executor };
});

it.effect('native transactions preserve caller services and execute the body once', () =>
  Effect.gen(function* preserveCallerServices() {
    class Service extends Context.Service<Service, { readonly value: object }>()(
      '@app/core-runtime/tests/unit/native-transaction.test/Service',
    ) {}
    const service = { value: {} };
    const h = yield* harness();
    let calls = 0;
    const value = yield* h.executor
      .transaction(() => {
        calls += 1;
        return Service.pipe(Effect.map((current) => current.value));
      })
      .pipe(Effect.provideService(Service, service));
    expect(value).toBe(service.value);
    expect(calls).toBe(1);
    expect(h.events).toEqual(['BEGIN', 'COMMIT']);
  }),
);

it.effect('native isolation configuration precedes transaction queries', () =>
  Effect.gen(function* configureIsolation() {
    const h = yield* harness();
    yield* h.executor.transaction((transaction) =>
      Effect.gen(function* snapshot() {
        yield* transaction.setTransaction({
          accessMode: 'read only',
          isolationLevel: 'repeatable read',
        });
        yield* transaction.execute(sql`select 1`, 'objects');
      }),
    );
    expect(h.events).toEqual([
      'BEGIN',
      'set transaction isolation level repeatable read read only',
      'select 1',
      'COMMIT',
    ]);
  }),
);

for (const [name, cause] of [
  ['typed failure', Cause.fail({ _tag: 'ExpectedFailure', identity: {} })],
  ['defect', Cause.die(new Error('body defect'))],
] as const) {
  it.effect(`native ${name} rolls back with the original cause`, () =>
    Effect.gen(function* rollbackOriginalCause() {
      const h = yield* harness();
      const exit = yield* Effect.exit(h.executor.transaction(() => Effect.failCause(cause)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) {
        throw new Error('Expected assertion to hold');
      }
      expect(exit.cause).toEqual(cause);
      expect(h.events).toEqual(['BEGIN', 'ROLLBACK']);
    }),
  );
}

it.effect('a synchronous body construction throw rolls back', () =>
  Effect.gen(function* rollbackConstructionThrow() {
    const h = yield* harness();
    const defect = new Error('construction defect');
    const exit = yield* Effect.exit(
      h.executor.transaction((): Effect.Effect<never> => {
        throw defect;
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) {
      throw new Error('Expected assertion to hold');
    }
    expect(exit.cause).toEqual(Cause.die(defect));
    expect(h.events).toEqual(['BEGIN', 'ROLLBACK']);
  }),
);

// Effect SQL keeps a failed COMMIT as its typed SqlError and turns a failed ROLLBACK into a defect.
const surfacesSettlementFailure = (cause: Cause.Cause<unknown>, phase: string, failure: SqlError): boolean =>
  cause.reasons.some((reason) =>
    phase === 'COMMIT'
      ? Cause.isFailReason(reason) && reason.error === failure
      : Cause.isDieReason(reason) && reason.defect === failure,
  );

for (const phase of ['COMMIT', 'ROLLBACK']) {
  it.effect(`native ${phase} failure surfaces the SQL defect`, () =>
    Effect.gen(function* surfaceSettlementFailure() {
      const failure = new SqlError({
        reason: new ConnectionError({ cause: new Error(`${phase} failed`) }),
      });
      const h = yield* harness((statement) => (statement === phase ? Effect.fail(failure) : Effect.void));
      const exit = yield* Effect.exit(
        h.executor.transaction(() => (phase === 'COMMIT' ? Effect.succeed(42) : Effect.fail('body failure'))),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) {
        throw new Error('Expected assertion to hold');
      }
      expect(surfacesSettlementFailure(exit.cause, phase, failure)).toBe(true);
      expect(h.events).toEqual(['BEGIN', phase]);
    }),
  );
}

it.effect(
  'interruption waits for body finalizers and native rollback settlement',
  () =>
    Effect.gen(function* waitForRollback() {
      const started = yield* Deferred.make<null>();
      const finalizing = yield* Deferred.make<null>();
      const releaseFinalizer = yield* Deferred.make<null>();
      const rollingBack = yield* Deferred.make<null>();
      const releaseRollback = yield* Deferred.make<null>();
      const h = yield* harness((statement) =>
        statement === 'ROLLBACK'
          ? Deferred.succeed(rollingBack, null).pipe(Effect.andThen(Deferred.await(releaseRollback)))
          : Effect.void,
      );
      const fiber = yield* h.executor
        .transaction(() =>
          Deferred.succeed(started, null).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(finalizing, null).pipe(Effect.andThen(Deferred.await(releaseFinalizer)))),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Deferred.await(finalizing);
      expect(fiber.pollUnsafe()).toBe(undefined);
      expect(h.events).toEqual(['BEGIN']);
      yield* Deferred.succeed(releaseFinalizer, null);
      yield* Deferred.await(rollingBack);
      expect(fiber.pollUnsafe()).toBe(undefined);
      yield* Deferred.succeed(releaseRollback, null);
      yield* Fiber.join(interrupt);
      const result = { events: h.events, exit: yield* Fiber.await(fiber) };
      expect(Exit.isFailure(result.exit)).toBe(true);
      if (!Exit.isFailure(result.exit)) {
        throw new Error('Expected assertion to hold');
      }
      expect(Cause.hasInterrupts(result.exit.cause)).toBe(true);
      expect(result.events).toEqual(['BEGIN', 'ROLLBACK']);
    }),
  2000,
);

for (const phase of ['COMMIT', 'ROLLBACK']) {
  it.effect(
    `interruption waits for native ${phase} and preserves a later SQL failure`,
    () =>
      Effect.gen(function* preserveSettlementFailure() {
        const failure = new SqlError({
          reason: new ConnectionError({
            cause: new Error(`${phase} rejected`),
          }),
        });
        const started = yield* Deferred.make<null>();
        const release = yield* Deferred.make<null>();
        const h = yield* harness((statement) =>
          statement === phase
            ? Deferred.succeed(started, null).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.fail(failure)),
              )
            : Effect.void,
        );
        const fiber = yield* h.executor
          .transaction(() => (phase === 'COMMIT' ? Effect.succeed(42) : Effect.fail('domain failure')))
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(fiber.pollUnsafe()).toBe(undefined);
        yield* Deferred.succeed(release, null);
        yield* Fiber.join(interrupt);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) {
          throw new Error('Expected assertion to hold');
        }
        // Native settlement failures take precedence over pending interruption.
        expect(surfacesSettlementFailure(exit.cause, phase, failure)).toBe(true);
      }),
    2000,
  );
}
