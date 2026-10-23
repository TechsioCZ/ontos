import { AddContactPointPayloadSchema, CounterpartyCustomerOnboardPayloadSchema } from '@app/party-registry/api';
import {
  addContactPointWithAuthorization,
  counterpartyCustomerOnboardWithAuthorization,
  resolvePartyCommandCommitWithAuthorization,
} from '@app/party-registry/api/client';
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
import { acquireRetailPartyGateway } from './retail-self-enrollment-party-owner.ts';
import type { RetailPartyCandidateOwnerInput } from './retail-self-enrollment-party-owner.ts';
import { retailSelfEnrollmentEvidenceReference } from './retail-self-enrollment-contracts.ts';

export interface RetailCustomerDirectoryOwnerInput extends Omit<RetailPartyCandidateOwnerInput, 'candidate'> {
  readonly partyRef: PartyRef;
  readonly registration: RetailEnrollmentRegistration;
  readonly validFrom: string;
}

const unavailable = (reason: string, cause?: unknown) =>
  ownerUnavailable('retail_customer_directory_unavailable', reason, cause);
const outcomeCode = 'retail_customer_directory_enrolled';

type CustomerCommand =
  | {
      readonly actionKey: 'party.registry.counterparty-customer-onboard';
      readonly payload: typeof CounterpartyCustomerOnboardPayloadSchema.Type;
    }
  | {
      readonly actionKey: 'party.registry.add-contact-point';
      readonly payload: typeof AddContactPointPayloadSchema.Type;
    };

/** Resolve each independently keyed command before dispatch; never retry an unknown acknowledgement. */
const runCommand = Effect.fn('RetailCustomerDirectory.runCommand')(function* runCommand(
  input: RetailCustomerDirectoryOwnerInput,
  ownerInvocationId: string,
  step: string,
  command: CustomerCommand,
) {
  const idempotencyKey = yield* Schema.decodeEffect(EnrollmentActionInvocationIdSchema)(
    retailSelfEnrollmentEvidenceReference(['retail-customer-directory', ownerInvocationId, step]),
  ).pipe(Effect.mapError((cause) => unavailable('The customer command identity is invalid', cause)));
  const recoveryGateway = yield* acquireRetailPartyGateway(input);
  const resolution = yield* resolvePartyCommandCommitWithAuthorization(
    { actionKey: command.actionKey, idempotencyKey },
    Redacted.value(recoveryGateway.credential),
    { ...recoveryGateway.options, correlationId: input.requestCorrelation },
  ).pipe(Effect.mapError((cause) => unavailable('The customer command state could not be resolved', cause)));
  if (resolution.state === 'COMMITTED') {
    return yield* Effect.void;
  }
  if (resolution.state === 'REJECTED') {
    return yield* ownerRejected(
      'retail_customer_command_rejected',
      'The original customer directory command was terminally rejected',
    );
  }
  if (!resolution.retryCommand) {
    return yield* unavailable('The original customer command is still running or indeterminate');
  }
  {
    const gateway = yield* acquireRetailPartyGateway(input);
    const options = { ...gateway.options, correlationId: input.requestCorrelation, idempotencyKey };
    const failed = (cause: unknown) =>
      unavailable('The governed customer command did not return a known outcome', cause);
    const dispatched =
      command.actionKey === 'party.registry.counterparty-customer-onboard'
        ? counterpartyCustomerOnboardWithAuthorization(
            command.payload,
            Redacted.value(gateway.credential),
            options,
          ).pipe(Effect.asVoid, Effect.mapError(failed))
        : addContactPointWithAuthorization(command.payload, Redacted.value(gateway.credential), options).pipe(
            Effect.asVoid,
            Effect.mapError(failed),
          );
    yield* dispatched;
  }
  return yield* Effect.void;
});

const contactPayload = (
  input: RetailCustomerDirectoryOwnerInput,
  evidenceReference: string,
  type: 'EMAIL' | 'PHONE',
  value: string,
) => {
  let contactPoint: (typeof AddContactPointPayloadSchema.Type)['contactPoint'];
  if (type === 'EMAIL') {
    contactPoint = { preferred: true, type, value };
  } else if (value.startsWith('+')) {
    contactPoint = { preferred: true, type, value };
  } else {
    contactPoint = { countryCode: 'CZ', preferred: true, type, value };
  }
  return Schema.decodeEffect(AddContactPointPayloadSchema)({
    contactPoint,
    partyRef: input.partyRef,
    privacyClassification: 'PERSONAL',
    provenance: { authoritative: false, evidenceReference, method: 'DECLARED_BY_PARTY', source: 'PARTY_DECLARATION' },
    validFrom: input.validFrom,
    // Account email verification does not prove the Party owner verified the contact point.
    verification: { state: 'UNVERIFIED' },
  }).pipe(Effect.mapError((cause) => unavailable('The declared customer contact is invalid', cause)));
};

const enrollDirectory = Effect.fn('RetailCustomerDirectory.enroll')(function* enrollDirectory(
  input: RetailCustomerDirectoryOwnerInput,
  ownerInvocationId: string,
) {
  const evidenceReference = `commerce.portal-enrollment:${ownerInvocationId}`;
  const onboard = yield* Schema.decodeEffect(CounterpartyCustomerOnboardPayloadSchema)({
    counterpartyProvenance: {
      evidenceReference,
      method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
      reason: 'Customer requested a retail purchasing relationship through governed portal enrollment',
      source: 'commerce.customer-context',
    },
    customerEvidence: {
      evidenceReference,
      method: 'APPROVED_PURCHASING_RELATIONSHIP',
      reason: 'Retail portal self-enrollment accepted under the selling legal entity policy',
      source: 'commerce.customer-context',
    },
    partyRef: input.partyRef,
    validFrom: input.validFrom,
  }).pipe(Effect.mapError((cause) => unavailable('The customer onboarding intent is invalid', cause)));
  const email = yield* contactPayload(input, evidenceReference, 'EMAIL', input.registration.email);
  const phone =
    input.registration.phone === undefined
      ? undefined
      : yield* contactPayload(input, evidenceReference, 'PHONE', input.registration.phone);
  yield* runCommand(input, ownerInvocationId, 'customer-role', {
    actionKey: 'party.registry.counterparty-customer-onboard',
    payload: onboard,
  });
  yield* runCommand(input, ownerInvocationId, 'email', {
    actionKey: 'party.registry.add-contact-point',
    payload: email,
  });
  if (phone !== undefined) {
    yield* runCommand(input, ownerInvocationId, 'phone', {
      actionKey: 'party.registry.add-contact-point',
      payload: phone,
    });
  }
});

/** The original enrollment claim remains the authority for the whole composed owner transition. */
export const retailCustomerDirectoryOwnerEffect = (
  originalInput: RetailCustomerDirectoryOwnerInput,
): CommerceEnrollmentOwnerEffect => {
  const input = Object.freeze({
    ...originalInput,
    partyRef: Object.freeze({ ...originalInput.partyRef }),
    registration: Object.freeze({ ...originalInput.registration }),
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
