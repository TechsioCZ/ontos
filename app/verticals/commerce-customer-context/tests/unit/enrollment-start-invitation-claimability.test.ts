import { randomUUID } from 'node:crypto';

import { Effect, Exit, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { ScopedRoutineInvocationError } from '@app/core-runtime';

import { commercePortalAuthEnrollmentInvitationClaimable } from '../../api/portal-auth/enrollment/http.ts';
import type { CommerceEnrollmentOwnerTransactionRun } from '../../src/enrollment/orchestration/owner-transition-production.ts';

/**
 * The gate a COUNTERPARTY_INVITATION start must clear before it spends any budget or creates an
 * Attempt: an unknown, consumed, revoked or expired invitation is refused here, so no Attempt and
 * no provider account is ever left behind for an invitation that could never complete.
 */

/** A `CommerceEnrollmentOwnerTransactionRun` that hands the callback a fake routine invoker whose
 * `invoke` answers with exactly the rows given, never touching a database. */
const runWithRows =
  (rows: readonly { readonly claimable: boolean }[]): CommerceEnrollmentOwnerTransactionRun =>
  (_scope, operation) =>
    operation({ invoke: () => Effect.succeed(rows) });

const runFailing =
  (reason: string): CommerceEnrollmentOwnerTransactionRun =>
  (_scope, operation) =>
    operation({
      invoke: () =>
        Effect.fail(
          new ScopedRoutineInvocationError({
            code: 'scoped_routine_invocation_failed',
            constraint: Option.none(),
            ownerModuleKey: 'commerce.customer-context',
            postgresCode: Option.none(),
            reason,
            routineKey: 'counterparty-access.read-invitation-claimability',
          }),
        ),
    });

const claimableFor = (run: CommerceEnrollmentOwnerTransactionRun) =>
  commercePortalAuthEnrollmentInvitationClaimable(run, randomUUID(), randomUUID(), randomUUID());

const claimabilityFor = (run: CommerceEnrollmentOwnerTransactionRun) => claimableFor(run).pipe(Effect.flip);

it.effect('lets a claimable invitation through', () =>
  Effect.gen(function* claimableProceeds() {
    const result = yield* Effect.exit(claimableFor(runWithRows([{ claimable: true }])));
    expect(Exit.isSuccess(result)).toBe(true);
  }),
);

it.effect('refuses an invitation the routine reports as not claimable, without naming why', () =>
  Effect.gen(function* notClaimableRefused() {
    const problem = yield* claimabilityFor(runWithRows([{ claimable: false }]));
    expect(problem.status).toBe(422);
    expect(problem.code).toBe('enrollment_journey_unavailable');
  }),
);

it.effect('refuses an unknown invitation id exactly as a not-claimable one', () =>
  Effect.gen(function* unknownRefusedIdentically() {
    const knownFalse = yield* claimabilityFor(runWithRows([{ claimable: false }]));
    const unknown = yield* claimabilityFor(runWithRows([]));
    // No row and an explicit `false` row answer identically: a caller can never distinguish an
    // invitation that does not exist from one that simply is not claimable right now.
    expect(unknown.status).toBe(knownFalse.status);
    expect(unknown.code).toBe(knownFalse.code);
  }),
);

it.effect('answers a retryable routine failure as unavailable, not as a permanent journey refusal', () =>
  Effect.gen(function* routineFailureIsRetryable() {
    const problem = yield* claimabilityFor(runFailing('the database is unreachable'));
    expect(problem.status).toBe(503);
    expect(problem.code).toBe('enrollment_unavailable');
  }),
);
