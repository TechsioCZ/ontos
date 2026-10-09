import { makeActionAuthorizationPreflightPermit } from '@app/core-runtime';
import type { ActionAuthorizationPreflightInput, OperationalScope, TrustedPrincipalContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ClaimPortalEnrollmentTransitionPayload } from '../../shared/actions/claim-portal-enrollment-transition.ts';
import type { RecordPortalEnrollmentOutcomePayload } from '../../shared/actions/record-portal-enrollment-outcome.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentDigestSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentModuleKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import {
  CommerceEnrollmentAttemptRejected,
  CommerceEnrollmentAttemptUnavailable,
} from '../../src/enrollment/attempts/errors.ts';
import {
  CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY,
  CommerceEnrollmentOwnerTransitionPreparation,
  CommerceEnrollmentPreparedOwnerCapability,
  makeCommerceEnrollmentPreparedOwnerExecution,
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
  RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY,
  composeActionAuthorizationPreflights,
} from '../../src/enrollment/orchestration/prepared-owner-authority.ts';

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000001');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('20000000-0000-4000-8000-000000000001');
const actionInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)(
  '30000000-0000-4000-8000-000000000001',
);
const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('40000000-0000-4000-8000-000000000001');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('50000000-0000-4000-8000-000000000001');
const evidenceRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)('60000000-0000-4000-8000-000000000001');
const ownerModuleKey = Schema.decodeSync(EnrollmentModuleKeySchema)(PORTAL_AUTH_OWNER_MODULE_KEY);
const transitionKey = Schema.decodeSync(EnrollmentTransitionKeySchema)(PORTAL_ACCOUNT_CREATION_TRANSITION_KEY);
const requestDigest = Schema.decodeSync(EnrollmentDigestSchema)('a'.repeat(64));

const principal: TrustedPrincipalContext = {
  authContextRef: 'job:enrollment:run:unit',
  authMethod: 'system',
  principalId: actorPrincipalId,
  tenantId,
};

const scope: OperationalScope = {
  ...principal,
  correlationId: 'enrollment-action-orchestration-unit',
};

const claimPayload = {
  expectedRevision: 1,
  ownerInvocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  requestDigest,
  transitionKey,
} satisfies ClaimPortalEnrollmentTransitionPayload;

const recordPayload = {
  expectedRevision: 2,
  ownerInvocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  transitionKey,
} satisfies RecordPortalEnrollmentOutcomePayload;

const inputFor = (
  actionKey: string,
  payload: ClaimPortalEnrollmentTransitionPayload | RecordPortalEnrollmentOutcomePayload,
): ActionAuthorizationPreflightInput => ({
  actionInvocationId,
  actionKey,
  correlationId: scope.correlationId,
  payload,
  principal,
  scope,
});

const claimBinding = {
  actionInvocationId,
  actionKey: CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY,
  actorPrincipalId,
  expectedRevision: claimPayload.expectedRevision,
  ownerInvocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  requestDigest,
  tenantId,
  transitionKey,
} as const;

const recordBinding = {
  actionInvocationId,
  actionKey: RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY,
  actorPrincipalId,
  expectedRevision: recordPayload.expectedRevision,
  ownerInvocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  tenantId,
  transitionKey,
} as const;

type CommerceEnrollmentOwnerPreparationService = CommerceEnrollmentOwnerTransitionPreparation['Service'];

const recordResolution = {
  actorPrincipalId,
  reconciliationRef: Schema.decodeSync(EnrollmentEvidenceReferenceSchema)('70000000-0000-4000-8000-000000000001'),
  status: 'SUCCEEDED' as const,
};

const preparation: CommerceEnrollmentOwnerPreparationService = {
  prepare: (input) =>
    input.actionKey === RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY
      ? Effect.succeed({ evidenceRef, outcome: 'prepared' as const, resolution: recordResolution })
      : Effect.succeed({ evidenceRef, outcome: 'prepared' as const }),
};

it.effect('stages prepared evidence without authorizing the Action and consumes exact claim binding once', () =>
  Effect.gen(function* stagesClaimEvidence() {
    const execution = makeCommerceEnrollmentPreparedOwnerExecution(preparation);
    const decision = yield* execution.preflight.prepare(
      inputFor(CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY, claimPayload),
    );
    expect(decision).toStrictEqual({ outcome: 'not_applicable' });

    const evidence = yield* execution.capability.take(claimBinding);
    expect(evidence.evidenceRef).toBe(evidenceRef);
    expect(evidence.ownerInvocationId).toBe(ownerInvocationId);

    const replay = yield* execution.capability.take(claimBinding).pipe(Effect.flip);
    expect(Schema.is(CommerceEnrollmentAttemptUnavailable)(replay)).toBe(true);
    execution.clear();
  }),
);

it.effect('requires authoritative resolution for record and rejects a substituted Actor binding', () =>
  Effect.gen(function* stagesRecordEvidence() {
    const execution = makeCommerceEnrollmentPreparedOwnerExecution(preparation);
    const decision = yield* execution.preflight.prepare(
      inputFor(RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY, recordPayload),
    );
    expect(decision).toStrictEqual({ outcome: 'not_applicable' });

    const wrongActorBinding = {
      ...recordBinding,
      actorPrincipalId: Schema.decodeSync(EnrollmentPrincipalIdSchema)('80000000-0000-4000-8000-000000000001'),
    };
    const mismatch = yield* execution.capability.take(wrongActorBinding).pipe(Effect.flip);
    expect(Schema.is(CommerceEnrollmentAttemptRejected)(mismatch)).toBe(true);

    const evidence = yield* execution.capability.take(recordBinding);
    expect(evidence.resolution?.status).toBe('SUCCEEDED');
    execution.clear();
  }),
);

it.effect('preserves a later ordinary preflight after owner preparation returns not_applicable', () =>
  Effect.gen(function* composesPreflights() {
    const execution = makeCommerceEnrollmentPreparedOwnerExecution(preparation);
    const laterPermit = makeActionAuthorizationPreflightPermit({
      actionInvocationId,
      actionKey: CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY,
      principalId: actorPrincipalId,
    });
    const laterPreflight = {
      prepare: () => Effect.succeed({ outcome: 'allowed' as const, permit: laterPermit }),
    };
    const decision = yield* composeActionAuthorizationPreflights([execution.preflight, laterPreflight]).prepare(
      inputFor(CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY, claimPayload),
    );
    expect(decision.outcome).toBe('allowed');
    execution.clear();
  }),
);

it('uses deterministic Context service identities for the prepared-owner seam', () => {
  expect(CommerceEnrollmentOwnerTransitionPreparation.key).toBe(
    '@app/commerce-customer-context/enrollment/orchestration/prepared-owner-authority/CommerceEnrollmentOwnerTransitionPreparation',
  );
  expect(CommerceEnrollmentPreparedOwnerCapability.key).toBe(
    '@app/commerce-customer-context/enrollment/orchestration/prepared-owner-authority/CommerceEnrollmentPreparedOwnerCapability',
  );
});
