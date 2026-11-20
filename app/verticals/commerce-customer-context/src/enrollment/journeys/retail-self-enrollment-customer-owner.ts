import {
  EnrollRetailCustomerPayloadSchema,
  EnrollRetailCustomerActionAlreadyCommittedProblemSchema,
  EnrollRetailCustomerActionConflictProblemSchema,
  EnrollRetailCustomerActionForbiddenProblemSchema,
  EnrollRetailCustomerActionIneligibleProblemSchema,
} from '@app/party-registry/api';
import {
  executeEnrollRetailCustomerWithAuthorization,
  executeOwnedRetailPartyResultWithAuthorization,
  resolvePartyCommandCommitWithAuthorization,
} from '@app/party-registry/api/client';
import type { acceptRetailEnrollmentEvidence } from '@app/party-registry/api/client';
import type { PartyRef } from '@app/party-registry/resources/party';
import { Effect, Redacted, Schema } from 'effect';

import { EnrollmentActionInvocationIdSchema } from '../../../shared/enrollment-contracts.ts';
import type { RetailEnrollmentRegistration } from '../../../shared/enrollment-contracts.ts';
import {
  decodeOwnerOutcome,
  decodeOwnerResolution,
  ownerRejected,
  ownerUnavailable,
} from '../orchestration/owner-effect-codec.ts';
import type { CommerceEnrollmentOwnerEffect } from '../orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerEffectError } from '../orchestration/owner-transition-errors.ts';
import { acquireRetailEnrollmentPartyGateway } from './retail-self-enrollment-party-owner.ts';
import type { RetailPartyCandidateOwnerInput } from './retail-self-enrollment-party-owner.ts';
import { retailSelfEnrollmentEvidenceReference } from './retail-self-enrollment-contracts.ts';

export interface RetailCustomerDirectoryOwnerInput extends Omit<RetailPartyCandidateOwnerInput, 'candidate'> {
  readonly originalPartyOwnerInvocationId: string;
  readonly partyRef: PartyRef;
  readonly registration: RetailEnrollmentRegistration;
  readonly verifiedEvidence: Effect.Effect<
    Parameters<typeof acceptRetailEnrollmentEvidence>[0]['evidence'],
    CommerceEnrollmentOwnerEffectError
  >;
}

interface RetailCustomerDeclaration {
  email: string;
  evidence: Effect.Success<RetailCustomerDirectoryOwnerInput['verifiedEvidence']>;
  originalInvocationId: string;
  phone?: { countryCode?: string; preferred: true; type: 'PHONE'; value: string };
}

const unavailable = (reason: string, cause?: unknown) =>
  ownerUnavailable('retail_customer_directory_unavailable', reason, cause);
const outcomeCode = 'retail_customer_directory_enrolled';

/**
 * Party answers these problems only after deciding the command against its own state, and the
 * governed command commits nothing. Re-sending the same command meets the same state, so treating
 * the refusal as an unknown outcome would retry it until the sweep budget is spent and leave the
 * owner operation unresolved, pinning its Application Composition release.
 */
const isDefinitePartyRefusal = Schema.is(
  Schema.Union([
    EnrollRetailCustomerActionConflictProblemSchema,
    EnrollRetailCustomerActionForbiddenProblemSchema,
    EnrollRetailCustomerActionIneligibleProblemSchema,
  ]),
);

/** The same key committing between the resolution and this dispatch is a known, successful outcome. */
const committedMeanwhile = Schema.is(EnrollRetailCustomerActionAlreadyCommittedProblemSchema);

const commandFailure = (cause: unknown) =>
  isDefinitePartyRefusal(cause)
    ? ownerRejected(cause.code, 'The Party Registry refused the customer directory command', cause)
    : unavailable('The governed customer command did not return a known outcome', cause);

/** Recover the original Party and one atomic, independently keyed customer command. */
const enrollDirectory = Effect.fn('RetailCustomerDirectory.enroll')(function* enrollDirectory(
  input: RetailCustomerDirectoryOwnerInput,
  ownerInvocationId: string,
) {
  const idempotencyKey = yield* Schema.decodeEffect(EnrollmentActionInvocationIdSchema)(
    retailSelfEnrollmentEvidenceReference(['retail-customer-directory', ownerInvocationId, 'enroll-retail-customer']),
  ).pipe(Effect.mapError((cause) => unavailable('The customer command identity is invalid', cause)));
  const recoveryGateway = yield* acquireRetailEnrollmentPartyGateway(input);
  const resolution = yield* resolvePartyCommandCommitWithAuthorization(
    { actionKey: 'party.registry.enroll-retail-customer', idempotencyKey },
    Redacted.value(recoveryGateway.credential),
    { ...recoveryGateway.options, correlationId: input.requestCorrelation },
  ).pipe(Effect.mapError((cause) => unavailable('The customer command state could not be resolved', cause)));
  if (resolution.state === 'COMMITTED') {
    return yield* Effect.void;
  }
  if (resolution.state === 'REJECTED') {
    return yield* ownerRejected(
      'retail_customer_command_rejected',
      'The original customer enrollment command was rejected',
    );
  }
  if (!resolution.retryCommand) {
    return yield* unavailable('The original customer command is still indeterminate');
  }
  const evidence = yield* input.verifiedEvidence;
  const originalGateway = yield* acquireRetailEnrollmentPartyGateway(input);
  const original = yield* executeOwnedRetailPartyResultWithAuthorization(
    { evidence: input.subject, idempotencyKey: input.originalPartyOwnerInvocationId },
    Redacted.value(originalGateway.credential),
    input.requestCorrelation,
    originalGateway.options,
  ).pipe(Effect.mapError((cause) => unavailable('The original owned Party Create cannot be proved', cause)));
  if (
    original.state !== 'COMMITTED' ||
    original.createResult === undefined ||
    original.createResult.outcome === 'AMBIGUOUS' ||
    original.createResult.partyRef.tenantId !== input.partyRef.tenantId ||
    original.createResult.partyRef.resourceId !== input.partyRef.resourceId
  ) {
    return yield* unavailable('The original Party Create does not prove this retained enrollment Party');
  }
  const rawPhone = input.registration.phone;
  const declared: RetailCustomerDeclaration = {
    email: input.registration.email,
    evidence,
    originalInvocationId: original.invocationId,
  };
  if (rawPhone !== undefined) {
    declared.phone = { preferred: true, type: 'PHONE', value: rawPhone };
    if (!rawPhone.startsWith('+')) {
      declared.phone.countryCode = 'CZ';
    }
  }
  const payload = yield* Schema.decodeUnknownEffect(EnrollRetailCustomerPayloadSchema)(declared).pipe(
    Effect.mapError((cause) => unavailable('The declared retail customer contacts are invalid', cause)),
  );
  const gateway = yield* acquireRetailEnrollmentPartyGateway(input);
  const enrolled = yield* executeEnrollRetailCustomerWithAuthorization(
    payload,
    Redacted.value(gateway.credential),
    input.requestCorrelation,
    {
      ...gateway.options,
      idempotencyKey,
    },
  ).pipe(
    Effect.catchIf(committedMeanwhile, () => Effect.undefined),
    Effect.mapError(commandFailure),
  );
  if (
    enrolled !== undefined &&
    (enrolled.partyRef.tenantId !== input.partyRef.tenantId ||
      enrolled.partyRef.resourceId !== input.partyRef.resourceId)
  ) {
    return yield* unavailable('The committed customer result does not name the original enrollment Party');
  }
  return yield* Effect.void;
});

/** The original enrollment claim remains the authority for the whole composed owner transition. */
export const retailCustomerDirectoryOwnerEffect = (
  originalInput: RetailCustomerDirectoryOwnerInput,
): CommerceEnrollmentOwnerEffect => {
  const input = Object.freeze({
    ...originalInput,
    originator: Object.freeze({ ...originalInput.originator }),
    partyRef: Object.freeze({ ...originalInput.partyRef }),
    registration: Object.freeze({ ...originalInput.registration }),
    subject: Object.freeze({ ...originalInput.subject }),
  });
  return {
    dispatch: (transition) =>
      enrollDirectory(input, transition.ownerInvocationId).pipe(
        Effect.andThen(() =>
          decodeOwnerOutcome(
            { outcomeCode, resultReference: input.partyRef.resourceId, status: 'SUCCEEDED' },
            'retail_customer_directory_unavailable',
            'The customer directory outcome is invalid',
          ),
        ),
      ),
    reconcile: (reconciliation) =>
      enrollDirectory(input, reconciliation.ownerInvocationId).pipe(
        Effect.andThen(() =>
          decodeOwnerResolution(
            {
              actorPrincipalId: reconciliation.actorPrincipalId,
              outcomeCode,
              reconciliationRef: retailSelfEnrollmentEvidenceReference([
                'retail-customer-directory-reconciled',
                reconciliation.ownerInvocationId,
              ]),
              resultReference: input.partyRef.resourceId,
              status: 'SUCCEEDED',
            },
            'retail_customer_directory_unavailable',
            'The customer directory reconciliation is invalid',
          ),
        ),
        Effect.catchTag('CommerceEnrollmentOwnerEffectRejected', (failure) =>
          decodeOwnerResolution(
            {
              actorPrincipalId: reconciliation.actorPrincipalId,
              failureCode: 'owner_rejected',
              failureReason: failure.reason,
              outcomeCode: failure.code,
              reconciliationRef: retailSelfEnrollmentEvidenceReference([
                'retail-customer-directory-rejected',
                reconciliation.ownerInvocationId,
              ]),
              status: 'FAILED',
            },
            'retail_customer_directory_unavailable',
            'The customer directory rejection is invalid',
          ),
        ),
      ),
  };
};
