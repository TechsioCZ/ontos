import { defineScopedRoutine } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentResourceIdSchema,
  RetailEnrollmentRegistrationSchema,
  enrollmentDigest,
  CommercePortalAccountSubjectSchema,
  EnrollmentTenantIdSchema,
} from '../../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot } from '../../../shared/enrollment-contracts.ts';
import { StartPortalEnrollmentPayloadSchema } from '../../../shared/actions/start-portal-enrollment.ts';
import type { EnrollmentAttemptScopedRoutineInvoker } from '../attempts/attempt-persistence.ts';
import type { JourneyDefinition, JourneyTransitionSpec } from './journey-contracts.ts';
import { retailSelfEnrollmentJourneyDefinition } from './retail-self-enrollment-contracts.ts';
import { attemptUnavailable } from '../attempts/errors.ts';

export const RETAIL_RESTART_PREFIX = 'commerce.retail-restart:';
export const RETAIN_RETAIL_RESULTS_TRANSITION = 'commerce.customer-context.retain-enrollment-results';
export const RetailEnrollmentRestartContextSchema = Schema.Struct({
  directoryOwnerInvocationIds: Schema.Array(EnrollmentActionInvocationIdSchema),
  directoryPartyId: Schema.optionalKey(EnrollmentResourceIdSchema),
  partyId: Schema.optionalKey(EnrollmentResourceIdSchema),
  profileId: Schema.optionalKey(EnrollmentResourceIdSchema),
  providerOwnerInvocationId: EnrollmentActionInvocationIdSchema,
  registration: RetailEnrollmentRegistrationSchema,
  retainedMask: Schema.Literals([0, 1, 3, 7]),
  sourceAttemptId: EnrollmentAttemptIdSchema,
});
export type RetailEnrollmentRestartContext = typeof RetailEnrollmentRestartContextSchema.Type;

export const retailRestartIdentity = (attempt: EnrollmentAttemptSnapshot) => {
  const match = /^commerce\.retail-restart:(?<source>[0-9a-f-]{36}):(?<mask>[0137])$/u.exec(attempt.intentKey);
  return attempt.journey === 'EXISTING_ACCOUNT' &&
    match !== null &&
    match.groups?.['source'] === attempt.targetResourceId
    ? Option.some({ retainedMask: Number(match.groups?.['mask']), sourceAttemptId: match.groups?.['source'] })
    : Option.none();
};

const restartContextRoutine = defineScopedRoutine({
  name: 'read_retail_enrollment_restart_context',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'boolean' },
  ],
  resultSchema: Schema.Struct({ context: RetailEnrollmentRestartContextSchema }),
  routineKey: 'portal-enrollment.restart-context.read',
  schema: 'commerce_customer_context',
});

/** Native predecessor proof; no owner row is copied or changed. */
export const readRetailEnrollmentRestartContext = (
  transaction: EnrollmentAttemptScopedRoutineInvoker,
  attemptId: string,
  asSource: boolean,
) =>
  transaction.invoke(restartContextRoutine, [attemptId, asSource]).pipe(
    Effect.mapError((cause) =>
      attemptUnavailable('Native enrollment predecessor proof is unavailable', undefined, cause),
    ),
    Effect.map((rows) => Option.fromNullishOr(rows[0]?.context)),
  );

const RestartIntentEvidenceSchema = Schema.Struct({
  accountSubject: Schema.OptionFromUndefinedOr(CommercePortalAccountSubjectSchema),
  context: RetailEnrollmentRestartContextSchema,
  tenantId: EnrollmentTenantIdSchema,
});

export const retailEnrollmentRestartIntent = (
  attempt: EnrollmentAttemptSnapshot,
  context: RetailEnrollmentRestartContext,
) =>
  Schema.encodeEffect(Schema.fromJsonString(RestartIntentEvidenceSchema))({
    accountSubject: Option.fromUndefinedOr(attempt.accountSubject),
    context,
    tenantId: attempt.tenantId,
  }).pipe(
    Effect.flatMap((evidence) =>
      Schema.decodeUnknownEffect(StartPortalEnrollmentPayloadSchema)({
        intentDigest: enrollmentDigest(evidence),
        intentKey: `${RETAIL_RESTART_PREFIX}${context.sourceAttemptId}:${context.retainedMask}`,
        journey: 'EXISTING_ACCOUNT',
        targetLegalEntityId: attempt.targetLegalEntityId,
        targetResourceId: context.sourceAttemptId,
      }),
    ),
    Effect.mapError((cause) => attemptUnavailable('The native restart intent is invalid', undefined, cause)),
  );

export const retainRetailResultsTransition: JourneyTransitionSpec = {
  ownerModuleKey: 'commerce.customer-context',
  required: true,
  transitionKey: RETAIN_RETAIL_RESULTS_TRANSITION,
};

/** Missing owners still execute; retained owners are proven by a distinct native reuse transition. */
export const retailRestartTarget = (attempt: EnrollmentAttemptSnapshot): JourneyDefinition => {
  const restart = retailRestartIdentity(attempt);
  if (Option.isNone(restart)) {
    return retailSelfEnrollmentJourneyDefinition;
  }
  const retained = new Set([
    ...([1, 3, 7].includes(restart.value.retainedMask) ? ['party.candidate.submit'] : []),
    ...([3, 7].includes(restart.value.retainedMask) ? ['party.customer.enroll'] : []),
    ...(restart.value.retainedMask === 7 ? ['commerce.customer-context.ensure-retail-customer-profile'] : []),
  ]);
  return {
    ...retailSelfEnrollmentJourneyDefinition,
    requiredTransitions: [
      retainRetailResultsTransition,
      ...retailSelfEnrollmentJourneyDefinition.requiredTransitions.filter((step) => !retained.has(step.transitionKey)),
    ],
  };
};
