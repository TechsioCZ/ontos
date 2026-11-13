import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import type { CommercePortalAuthAuditEvent } from '../../src/portal-auth/audit/audit-contracts.ts';
import { CommercePortalAuthAuditUnavailable } from '../../src/portal-auth/audit/audit-unavailable.ts';
import { recordAppliedOutcome } from '../../src/portal-auth/audit/own-portal-outcome.ts';

/*
 * The final row of an applied profile or consent change. The change already happened when this row is written, so a
 * write that fails must not answer the buyer 503 with only a "requested" row in the audit: the row then says
 * `outcome_unknown`, and the change is still delivered.
 */

const subject = {
  actionInvocationId: '00000000-0000-4000-8000-0000000000a1',
  operation: 'customer-profile-update',
  providerSubjectId: 'provider-subject',
  sessionRef: 'session-ref',
};
const EVENTS = {
  success: 'commerce.portal-auth.profile-updated.v1',
  unknown: 'commerce.portal-auth.profile-update-outcome-unknown.v1',
} as const;

/** A recorder that refuses the first `failures` writes, keeping every row it accepts. */
const recorder = (failures: number) => {
  const rows: CommercePortalAuthAuditEvent[] = [];
  let refused = 0;
  return {
    record: (event: CommercePortalAuthAuditEvent) =>
      Effect.suspend(() => {
        if (refused < failures) {
          refused += 1;
          return Effect.fail(
            new CommercePortalAuthAuditUnavailable({ operation: 'record', reason: 'audit store unavailable' }),
          );
        }
        rows.push(event);
        return Effect.void;
      }),
    rows,
  };
};

const outcomesOf = (rows: readonly CommercePortalAuthAuditEvent[]) =>
  rows.map(({ eventType, outcome }) => ({ eventType, outcome }));

it.effect('a written success row is the one outcome row', () =>
  Effect.gen(function* successRow() {
    const audit = recorder(0);
    yield* recordAppliedOutcome(audit, subject, EVENTS);
    expect(outcomesOf(audit.rows)).toEqual([{ eventType: EVENTS.success, outcome: 'success' }]);
  }),
);

it.effect('a success row that cannot be written becomes outcome_unknown, and the applied change still succeeds', () =>
  Effect.gen(function* unknownRow() {
    const audit = recorder(1);
    const exit = yield* Effect.exit(recordAppliedOutcome(audit, subject, EVENTS));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(outcomesOf(audit.rows)).toEqual([{ eventType: EVENTS.unknown, outcome: 'outcome_unknown' }]);
  }),
);

it.effect('an audit store that refuses both rows still never turns the applied change into a refusal', () =>
  Effect.gen(function* noRow() {
    const audit = recorder(2);
    const exit = yield* Effect.exit(recordAppliedOutcome(audit, subject, EVENTS));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(audit.rows).toEqual([]);
  }),
);
