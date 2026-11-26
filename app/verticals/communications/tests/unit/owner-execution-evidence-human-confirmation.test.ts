import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { recordOwnerExecutionEvidenceAction } from '../../src/actions/record-owner-execution-evidence.action.ts';
import { OwnerExecutionEvidence } from '../../src/services/owner-execution-evidence.service.ts';
import { OwnerExecutionEvidenceRejected } from '../../shared/owner-execution-evidence-errors.ts';
import type { RecordOwnerExecutionEvidencePayload } from '../../shared/owner-execution-evidence.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '77777777-7777-4777-8777-777777777777';
const session = {
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'better-auth-session:owner-evidence-human',
  authMethod: 'session' as const,
  principalId,
  tenantId,
};
const apiKey = { ...session, authContextRef: 'api-key:FICTIONAL-service', authMethod: 'api_key' as const };
const system = {
  authContextRef: 'job:FICTIONAL-job:run:1',
  authMethod: 'system' as const,
  principalId,
  tenantId,
};
const impersonation = {
  ...session,
  authMethod: 'support_impersonation' as const,
  impersonatedByPrincipalId: '88888888-8888-4888-8888-888888888888',
};

const payload: RecordOwnerExecutionEvidencePayload = {
  evidenceRef: 'FICTIONAL-evidence-1',
  handoffFingerprint: 'a'.repeat(64),
  idempotencyKey: 'FICTIONAL-idempotency-1',
  phase: 'RECEIVED',
  results: [],
};
const transport = (key: string) => ({ correlationId: key, idempotencyKey: key });

/**
 * [#1410 AC-06, D.8, GOV-07, audit T3-22] The evidence Action records ONE authorized HUMAN's confirmation. The confirmation
 * reference Privacy later reads as `confirmedByHumanRef` is the invocation that carried it, so only an invocation of an
 * interactive human session may carry one: a service (api key), a system job and a support impersonation never confirm.
 */
const run = (principal: typeof session | typeof apiKey | typeof system | typeof impersonation) =>
  Effect.gen(function* runEffect() {
    const calls: string[] = [];
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      ownerRegistration: communicationsRegistration,
      services: [
        bindActionTestServices(recordOwnerExecutionEvidenceAction, {
          evidence: OwnerExecutionEvidence.of({
            record: (recorded) => {
              calls.push(recorded.evidenceRef);
              return Effect.succeed({
                continuation: Option.none(),
                result: { destructiveActionPerformed: false, evidenceRef: recorded.evidenceRef, outcome: 'RECORDED' },
              });
            },
          }),
        }),
      ],
    });
    const result = yield* harness.runtime
      .runAction({ payload, principal, registration: recordOwnerExecutionEvidenceAction, transport: transport('k1') })
      .pipe(Effect.result);
    return { calls, result };
  });

describe('record-owner-execution-evidence accepts a confirmation only from a human principal', () => {
  it.effect('records the confirmation of an interactive human session', () =>
    Effect.gen(function* human() {
      const { calls, result } = yield* run(session);
      expect(Result.isSuccess(result)).toBe(true);
      expect(calls).toEqual([payload.evidenceRef]);
    }),
  );

  it.effect('refuses a service (api key) principal with a typed refusal and stores nothing', () =>
    Effect.gen(function* refused() {
      const { calls, result } = yield* run(apiKey);
      const failure = Option.getOrUndefined(Result.getFailure(result));
      expect(Schema.is(OwnerExecutionEvidenceRejected)(failure)).toBe(true);
      expect(failure).toMatchObject({ refusal: 'CONFIRMATION_REQUIRES_A_HUMAN_PRINCIPAL' });
      expect(calls).toEqual([]);
    }),
  );

  // Core's own context validation may refuse these before the handler is reached; either way nothing is stored.
  for (const [name, principal] of [
    ['a system job principal', system],
    ['a support impersonation', impersonation],
  ] as const) {
    it.effect(`stores nothing for ${name}`, () =>
      Effect.gen(function* notStored() {
        const { calls, result } = yield* run(principal);
        expect(Result.isFailure(result)).toBe(true);
        expect(calls).toEqual([]);
      }),
    );
  }
});
