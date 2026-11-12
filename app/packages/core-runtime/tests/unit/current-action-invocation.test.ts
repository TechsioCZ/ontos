import { Effect, Exit, Option, Schema } from 'effect';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { bindScopedWorkloadAdmission } from '../../src/access/enforcement/workload-admission.ts';
import { readScopedCurrentActionInvocation } from '../../src/actions/current-invocation.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import { OperationContextUnavailable } from '../../src/operations/errors.ts';
import { makeTestDatabase } from '../support/database.ts';

const scope = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '11111111-1111-4111-8111-111111111111',
    authContextRef: 'current-action-fixture',
    authMethod: 'session',
    legalEntityId: '22222222-2222-4222-8222-222222222222',
    principalId: '33333333-3333-4333-8333-333333333333',
    tenantId: '44444444-4444-4444-8444-444444444444',
  }),
  correlationId: 'current-action-fixture',
});
const current = {
  actionInvocationId: '55555555-5555-4555-8555-555555555555',
  actionKey: 'party.registry.current-action-fixture',
  idempotencyKey: '66666666-6666-4666-8666-666666666666',
  legalEntityId: scope.legalEntityId ?? null,
  principalId: scope.principalId,
  status: 'running',
  tenantId: scope.tenantId,
};

/** Private seal fault fixture; the separate native test proves its real ActionRuntime issuer. */
const fixture = Effect.fn('CurrentActionFixture.make')(function* fixture(
  readRows: (sql: string, parameters: readonly unknown[]) => Effect.Effect<readonly object[], SqlError>,
) {
  const database = yield* makeTestDatabase((sql, parameters) => {
    if (sql.includes('current_setting')) {
      return Effect.succeed([
        { legal_entity_id: scope.legalEntityId, role: 'ontos_runtime', tenant_id: scope.tenantId },
      ]);
    }
    if (sql.includes('"core"."action_invocations"')) {
      return readRows(sql, parameters);
    }
    return Effect.succeed([]);
  });
  const installed = yield* installOperationalScope(database, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
  const bound = bindScopedWorkloadAdmission(installed, {
    actionInvocationId: current.actionInvocationId,
    carrier: {},
    scope,
  });
  return { bound, installed };
});

it.effect('reads only the sealed running identity with exact scope predicates and immutable optional facts', () =>
  Effect.gen(function* exactCurrentIdentity() {
    const { bound } = yield* fixture((sql, parameters) => {
      expect(sql).toContain('"principal_id" =');
      expect(sql).toContain('"legal_entity_id" =');
      expect(parameters).toEqual([
        current.actionInvocationId,
        scope.tenantId,
        scope.principalId,
        scope.legalEntityId,
        'running',
        2,
      ]);
      return Effect.succeed([current]);
    });
    const fact = yield* readScopedCurrentActionInvocation(bound.transaction, scope);
    expect(fact).toEqual({
      actionInvocationId: current.actionInvocationId,
      actionKey: current.actionKey,
      idempotencyKey: Option.some(current.idempotencyKey),
      legalEntityId: Option.some(scope.legalEntityId),
      principalId: scope.principalId,
      tenantId: scope.tenantId,
    });
    expect(Object.isFrozen(fact)).toBe(true);
    expect(Object.isFrozen(fact.idempotencyKey)).toBe(true);
    expect(Object.isFrozen(fact.legalEntityId)).toBe(true);
    bound.close();
  }),
);

it.effect('refuses unsealed worker, Read, copied, descriptor-copied, wrapped, foreign scope and expired contexts', () =>
  Effect.gen(function* identityAndLifetimeRefusals() {
    const { bound, installed } = yield* fixture(() => Effect.die('Invalid identity must not query SQL'));
    const read = bindScopedWorkloadAdmission(installed, { carrier: {}, scope });
    const copied = { ...bound.transaction };
    const descriptors = Object.defineProperties(
      { ...bound.transaction },
      Object.getOwnPropertyDescriptors(bound.transaction),
    );
    for (const [transaction, exactScope] of [
      [installed, scope],
      [read.transaction, scope],
      [copied, scope],
      [descriptors, scope],
      [{ ...bound.transaction, invoke: bound.transaction.invoke }, scope],
      [bound.transaction, { ...scope }],
      [bound.transaction, { ...scope, principalId: '77777777-7777-4777-8777-777777777777' }],
    ] as const) {
      expect(
        Schema.is(OperationContextUnavailable)(
          yield* readScopedCurrentActionInvocation(transaction, exactScope).pipe(Effect.flip),
        ),
      ).toBe(true);
    }
    const delayed = readScopedCurrentActionInvocation(bound.transaction, scope);
    bound.close();
    read.close();
    expect(Exit.isFailure(yield* Effect.exit(delayed))).toBe(true);
  }),
);

it.effect('refuses missing, duplicate, foreign or non-running native rows', () =>
  Effect.gen(function* invalidNativeRows() {
    for (const rows of [
      [],
      [current, current],
      [{ ...current, actionInvocationId: '77777777-7777-4777-8777-777777777777' }],
      [{ ...current, tenantId: '77777777-7777-4777-8777-777777777777' }],
      [{ ...current, principalId: '77777777-7777-4777-8777-777777777777' }],
      [{ ...current, legalEntityId: null }],
      [{ ...current, status: 'succeeded' }],
    ]) {
      const { bound } = yield* fixture(() => Effect.succeed(rows));
      expect(
        Schema.is(OperationContextUnavailable)(
          yield* readScopedCurrentActionInvocation(bound.transaction, scope).pipe(Effect.flip),
        ),
      ).toBe(true);
      bound.close();
    }
  }),
);

it.effect('rechecks lifetime after native I/O and maps database failure to an unavailable fact', () =>
  Effect.gen(function* lifetimeDuringRead() {
    const close: (() => void)[] = [];
    const { bound } = yield* fixture(() =>
      Effect.sync(() => {
        for (const end of close) {
          end();
        }
        return [current];
      }),
    );
    close.push(bound.close);
    expect(
      Schema.is(OperationContextUnavailable)(
        yield* readScopedCurrentActionInvocation(bound.transaction, scope).pipe(Effect.flip),
      ),
    ).toBe(true);
    const broken = yield* fixture(() =>
      Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'synthetic fixture disconnect' }) })),
    );
    expect(
      Schema.is(OperationContextUnavailable)(
        yield* readScopedCurrentActionInvocation(broken.bound.transaction, scope).pipe(Effect.flip),
      ),
    ).toBe(true);
    broken.bound.close();
  }),
);

it.effect('preserves absence of a native idempotency key instead of inventing one', () =>
  Effect.gen(function* optionalIdempotencyKey() {
    const { bound } = yield* fixture(() => Effect.succeed([{ ...current, idempotencyKey: null }]));
    const fact = yield* readScopedCurrentActionInvocation(bound.transaction, scope);
    expect(Option.isNone(fact.idempotencyKey)).toBe(true);
    bound.close();
  }),
);
