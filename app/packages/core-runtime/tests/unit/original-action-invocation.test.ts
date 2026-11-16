import { Effect, Option, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { readOriginalActionInvocationFacts } from '../../src/access/workloads/original-action-invocation.ts';
import { makeTestDatabase } from '../support/database.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const originalPrincipalId = '20000000-0000-4000-8000-000000000002';
const query = {
  actionKey: 'owner.source.apply',
  authContextRef: 'job:source-worker:run:native-run',
  idempotencyKey: 'exact-permanent-command',
  originalPrincipalId,
  requestHash: 'a'.repeat(64),
};

it.effect(
  'reads the exact historical Action tuple inside its scoped Tenant without requiring current original authority',
  () =>
    Effect.gen(function* historicalInvocationFacts() {
      let rows = [{ actionInvocationId: '30000000-0000-4000-8000-000000000003', status: 'succeeded' }];
      const parameters: (readonly unknown[])[] = [];
      const database = yield* makeTestDatabase((statement, values) => {
        expect(statement).toContain('"core"."action_invocations"');
        expect(statement).not.toContain('"principals"');
        expect(statement).not.toContain('"access_workload_bindings"');
        parameters.push(values);
        return Effect.succeed(rows);
      });
      const result = yield* readOriginalActionInvocationFacts(database, tenantId, query);
      expect(Option.getOrUndefined(result)).toEqual(rows[0]);
      expect(parameters[0]).toEqual([
        tenantId,
        originalPrincipalId,
        query.actionKey,
        query.idempotencyKey,
        query.requestHash,
        query.authContextRef,
        2,
      ]);
      rows = [];
      expect(Option.isNone(yield* readOriginalActionInvocationFacts(database, tenantId, query))).toBe(true);
      rows = [
        { actionInvocationId: 'one', status: 'succeeded' },
        { actionInvocationId: 'two', status: 'succeeded' },
      ];
      expect(
        Predicate.isTagged(
          yield* Effect.flip(readOriginalActionInvocationFacts(database, tenantId, query)),
          'AccessDecisionUnavailable',
        ),
      ).toBe(true);
    }),
);
