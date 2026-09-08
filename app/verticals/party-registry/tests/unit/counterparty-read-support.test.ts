import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { assert, it } from 'effect-rstest';

import { CounterpartyPersistenceUnavailable } from '../../shared/domain/counterparty-errors.ts';
import { resolveCounterpartyRead } from '../../src/api/counterparty-read-support.ts';

const ref = {
  moduleId: 'party.registry',
  resourceType: 'party.registry.counterparty',
  resourceId: 'counterparty-id',
  tenantId: 'tenant-id',
} as const;
const reason = 'Counterparty persistence is temporarily unavailable';

it.effect(
  'cross-tenant counterparty reads never resolve the persistence service',
  () =>
    Effect.gen(function* rejectCrossTenant() {
      let calls = 0;
      const failure = yield* resolveCounterpartyRead<never>(
        ref,
        'another-tenant',
        () => {
          calls += 1;
          return Effect.succeed({ _tag: 'not_found' } as const);
        },
        reason
      ).pipe(Effect.flip);
      assert.equal(calls, 0);
      assert.ok(Schema.is(ReadHandlerNotFound)(failure));
      assert.equal(
        failure.reason,
        'The Counterparty does not exist in the trusted Tenant'
      );
    })
);

it.effect(
  'counterparty lookup preserves found values and authorized-context absence',
  () =>
    Effect.gen(function* preserveLookupResult() {
      const value = [{ role: 'CUSTOMER' }];
      const found = yield* resolveCounterpartyRead(
        ref,
        ref.tenantId,
        (id) => {
          assert.equal(id, ref.resourceId);
          return Effect.succeed({ _tag: 'found', value } as const);
        },
        reason
      );
      assert.equal(found, value);
      const missing = yield* resolveCounterpartyRead<never>(
        ref,
        ref.tenantId,
        () => Effect.succeed({ _tag: 'not_found' } as const),
        reason
      ).pipe(Effect.flip);
      assert.ok(Schema.is(ReadHandlerNotFound)(missing));
      assert.equal(
        missing.reason,
        'The Counterparty does not exist in the authorized context'
      );
    })
);

it.effect(
  'counterparty failures preserve the per-read reason and nonenumerable cause',
  () =>
    Effect.gen(function* preserveFailureCause() {
      const cause = new CounterpartyPersistenceUnavailable({
        code: 'counterparty_persistence_unavailable',
        reason: 'database unavailable',
      });
      const historyReason =
        'Counterparty Role history is temporarily unavailable';
      const failure = yield* resolveCounterpartyRead<never>(
        ref,
        ref.tenantId,
        () => Effect.fail(cause),
        historyReason
      ).pipe(Effect.flip);
      assert.ok(Schema.is(ReadHandlerUnavailable)(failure));
      assert.equal(failure.reason, historyReason);
      assert.equal(failure.cause, cause);
      assert.equal(
        Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable,
        false
      );
    })
);
