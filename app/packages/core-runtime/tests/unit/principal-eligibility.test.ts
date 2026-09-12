import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makePrincipalEligibility } from '../../src/permissions/principal-eligibility.ts';
import type { PrincipalEligibilityRecord } from '../../src/permissions/principal-eligibility.ts';

const principal = {
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '20000000-0000-4000-8000-000000000001',
} as const;

class TestDatabaseFailure extends Schema.TaggedError<TestDatabaseFailure>()('TestDatabaseFailure', {
  reason: Schema.String,
}) {}

const persistenceWith = (rows: readonly PrincipalEligibilityRecord[] | 'failure') => ({
  loadPrincipal: () =>
    rows === 'failure'
      ? Effect.fail(new TestDatabaseFailure({ reason: 'secret database detail' }))
      : Effect.succeed(rows),
});

it.effect('accepts only one active tenant-qualified Principal', () =>
  Effect.gen(function* activePrincipal() {
    const result = yield* makePrincipalEligibility(
      persistenceWith([{ status: 'active', tenantId: principal.tenantId }]),
    ).resolve(principal);
    expect(result).toEqual({ decision: 'eligible', principal, reason: 'active' });
  }),
);

it.effect('classifies inactive, missing, and persistence failures without diagnostics', () =>
  Effect.gen(function* classifyPrincipalFailures() {
    const inactive = yield* makePrincipalEligibility(
      persistenceWith([{ status: 'disabled', tenantId: principal.tenantId }]),
    ).resolve(principal);
    const missing = yield* makePrincipalEligibility(persistenceWith([])).resolve(principal);
    const unavailable = yield* makePrincipalEligibility(persistenceWith('failure')).resolve(principal);
    expect(inactive.reason).toBe('inactive');
    expect(missing.reason).toBe('missing');
    expect(unavailable).toEqual({
      decision: 'unavailable',
      principal,
      reason: 'indeterminate',
    });
  }),
);
