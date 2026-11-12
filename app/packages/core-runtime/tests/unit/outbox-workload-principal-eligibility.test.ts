import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { readWorkerWorkloadPrincipalEligibility } from '../../src/outbox/workload-principal-eligibility.ts';
import { makeTestDatabase } from '../support/database.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000002';
const query = { kind: 'integration' as const, principalId, workloadKey: 'integration.symmy-admit' };

it.effect('binds native eligibility to the scoped Tenant, exact actor kind and active workload', () =>
  Effect.gen(function* readExactWorkloadEligibility() {
    let eligible = true;
    const parameters: (readonly unknown[])[] = [];
    const database = yield* makeTestDatabase((statement, values) => {
      expect(statement).toContain('"core"."principals"');
      expect(statement).toContain('"core"."tenants"');
      expect(statement).toContain('"core"."access_workload_bindings"');
      parameters.push(values);
      return Effect.succeed(eligible ? [{ principalId }] : []);
    });
    const read = (input: Parameters<typeof readWorkerWorkloadPrincipalEligibility>[2]) =>
      readWorkerWorkloadPrincipalEligibility(database, tenantId, input);
    expect(yield* read(query)).toBe(true);
    expect(parameters[0]).toEqual([
      tenantId,
      principalId,
      'integration',
      'active',
      'active',
      query.workloadKey,
      'active',
      1,
    ]);
    eligible = false;
    expect(yield* read(query)).toBe(false);
    expect(parameters).toHaveLength(2);
  }),
);

it.effect('rejects malformed eligibility queries before reaching the scoped database', () =>
  Effect.gen(function* rejectInvalidEligibilityQuery() {
    let queries = 0;
    const database = yield* makeTestDatabase(() => {
      queries += 1;
      return Effect.succeed([]);
    });
    const read = (input: Parameters<typeof readWorkerWorkloadPrincipalEligibility>[2]) =>
      readWorkerWorkloadPrincipalEligibility(database, tenantId, input);
    const failures = [
      yield* Effect.flip(read({ ...query, principalId: 'invalid' })),
      yield* Effect.flip(read({ ...query, workloadKey: 'not a workload' })),
    ];
    expect(failures.every((failure) => Predicate.isTagged(failure, 'OutboxWorkerTenantScopeError'))).toBe(true);
    expect(queries).toBe(0);
  }),
);
