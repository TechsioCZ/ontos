import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  RecordEnrollmentOutcomeInputSchema,
  StartEnrollmentAttemptInputSchema,
} from '../../shared/enrollment-contracts.ts';
import { commerceEnrollmentAttemptPersistenceForTransaction } from '../../src/enrollment/attempts/attempt-persistence.ts';
import type { EnrollmentAttemptScopedRoutineInvoker } from '../../src/enrollment/attempts/attempt-persistence.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const attemptId = '20000000-0000-4000-8000-000000000001';
const originatorId = '30000000-0000-4000-8000-000000000001';
const ownerInvocationId = '30000000-0000-4000-8000-000000000002';
const principalId = '40000000-0000-4000-8000-000000000001';
const operationId = '50000000-0000-4000-8000-000000000001';
const leaseToken = '60000000-0000-4000-8000-000000000001';
const at = '2026-09-17T10:00:00.000Z';
const compositionRevision = 'c'.repeat(64);
const intentDigest = 'a'.repeat(64);
const start = Schema.decodeUnknownSync(StartEnrollmentAttemptInputSchema)({
  actionInvocationId: originatorId,
  actorPrincipalId: principalId,
  compositionRevision,
  intentDigest,
  intentKey: 'originator-projection',
  journey: 'RETAIL_SELF_ENROLLMENT',
  tenantId,
});
const record = Schema.decodeUnknownSync(RecordEnrollmentOutcomeInputSchema)({
  actorPrincipalId: principalId,
  expectedRevision: 1,
  leaseToken,
  ownerInvocationId,
  ownerModuleKey: 'party.registry',
  portalEnrollmentAttemptId: attemptId,
  status: 'SUCCEEDED',
  tenantId,
  transitionKey: 'party.identity.create',
  workerId: 'originator-worker',
});

const fixture = (originator: string | null) => {
  let revision = 1;
  const originatorReads: (readonly unknown[])[] = [];
  const invoke: EnrollmentAttemptScopedRoutineInvoker['invoke'] = (routine, values) =>
    Effect.sync(() => {
      if (routine.name === 'read_portal_enrollment_originator') {
        originatorReads.push(values);
        return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([
          { originator_action_invocation_id: originator },
        ]);
      }
      const recorded = routine.name === 'record_portal_enrollment_outcome';
      if (recorded) {
        revision += 1;
      }
      return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([
        {
          attempt_outcome: recorded ? 'RECORDED' : 'CREATED',
          authentication_namespace_id: null,
          completed_at: null,
          composition_revision: compositionRevision,
          created_at: at,
          created_by_principal_id: principalId,
          failure_code: null,
          failure_reason: null,
          intent_digest: intentDigest,
          intent_key: start.intentKey,
          invitation_id: null,
          journey: start.journey,
          last_failure_code: null,
          last_failure_reason: null,
          last_owner_invocation_id: null,
          lease_expires_at: null,
          lease_owner: null,
          lease_token: null,
          operation_actor_principal_id: principalId,
          operation_id: operationId,
          operation_lease_expires_at: null,
          operation_lease_owner: null,
          operation_lease_token: null,
          operation_revision: 1,
          operation_status: 'SUCCEEDED',
          outcome_code: null,
          owner_invocation_id: ownerInvocationId,
          owner_module_key: record.ownerModuleKey,
          portal_enrollment_attempt_id: attemptId,
          provider_subject_id: null,
          reconciliation_ref: null,
          request_digest: 'b'.repeat(64),
          required: true,
          result_digest: null,
          result_reference: null,
          revision,
          state: 'IN_PROGRESS',
          subject_type: null,
          target_legal_entity_id: null,
          target_resource_id: null,
          tenant_id: tenantId,
          terminated_at: null,
          transition_key: record.transitionKey,
          updated_at: at,
        },
      ]);
    });
  return {
    originatorReads,
    persistence: commerceEnrollmentAttemptPersistenceForTransaction({ invoke }, { tenantId }),
  };
};

it.effect('returns the persisted originator on creation and outcome recording exactly as a reread does', () =>
  Effect.gen(function* immutableOriginatorProjection() {
    const { originatorReads, persistence } = fixture(originatorId);
    const created = yield* persistence.create(start);
    expect(created.attempt.originatorActionInvocationId).toBe(originatorId);
    const read = { portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId, tenantId: start.tenantId };
    expect(yield* persistence.read(read)).toEqual(created.attempt);
    const recorded = yield* persistence.record(record, 'IN_PROGRESS');
    expect(recorded.attempt.originatorActionInvocationId).toBe(originatorId);
    expect(recorded.attempt.originatorActionInvocationId).not.toBe(ownerInvocationId);
    expect(yield* persistence.read(read)).toEqual(recorded.attempt);
    expect(originatorReads).toEqual([[attemptId], [attemptId], [attemptId], [attemptId]]);
  }),
);

it.effect('never substitutes an owner invocation when the persisted originator is absent', () =>
  Effect.gen(function* absentOriginatorProjection() {
    const { persistence } = fixture(null);
    const created = yield* persistence.create(start);
    expect(created.attempt).not.toHaveProperty('originatorActionInvocationId');
    const recorded = yield* persistence.record(record, 'IN_PROGRESS');
    expect(recorded.attempt).not.toHaveProperty('originatorActionInvocationId');
    expect(
      yield* persistence.read({
        portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId,
        tenantId: start.tenantId,
      }),
    ).toEqual(recorded.attempt);
  }),
);
