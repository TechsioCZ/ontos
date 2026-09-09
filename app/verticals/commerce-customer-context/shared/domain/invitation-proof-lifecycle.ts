import { Context, Effect } from 'effect';
import type {
  AccessInstant,
  CounterpartyPermissionScope,
  CounterpartyRef,
  PrincipalRef,
} from './access-contract.ts';
import type { CounterpartyAccessDomainError } from './access-error.ts';
import { CounterpartyAccessUnavailable } from './counterparty-access-unavailable.ts';
import type { InvitationClaimProofReference } from './invitation-contract.ts';
import type { CounterpartyPermissionCode } from './permission-catalog.ts';
import type { CounterpartyAccessInvitationRef } from '../resources/counterparty-access-invitation.ts';

export interface CounterpartyInvitationProofRegistrationInput {
  readonly actionInvocationId: string;
  readonly counterpartyRef: CounterpartyRef;
  readonly deliveryMethod: 'VERIFIED_CONTACT_POINT' | 'APPROVED_RECIPIENT_DISCOVERY';
  readonly deliveryReference: string;
  readonly expiresAt: AccessInstant;
  readonly intendedPermissions: readonly CounterpartyPermissionCode[];
  readonly invitationRef: CounterpartyAccessInvitationRef;
  readonly inviter: PrincipalRef;
  readonly legalEntityId: string;
  readonly scope: CounterpartyPermissionScope;
}

export type CounterpartyInvitationProofRegistration = Readonly<{
  readonly proofReference: InvitationClaimProofReference;
  readonly proofVersion: 'commerce-invitation-proof.v1';
  readonly state: 'DELIVERY_STAGED' | 'DELIVERY_STAGE_REPLAYED';
}>;

export interface CounterpartyInvitationProofLifecycleService {
  readonly issueAndStageDelivery: (
    input: CounterpartyInvitationProofRegistrationInput,
  ) => Effect.Effect<CounterpartyInvitationProofRegistration, CounterpartyAccessDomainError>;
  readonly rotateAndStageDelivery: (
    input: CounterpartyInvitationProofRegistrationInput,
  ) => Effect.Effect<CounterpartyInvitationProofRegistration, CounterpartyAccessDomainError>;
}

export class CounterpartyInvitationProofLifecycle extends Context.Service<
  CounterpartyInvitationProofLifecycle,
  CounterpartyInvitationProofLifecycleService
>()(
  '@app/commerce-customer-context/shared/domain/invitation-proof-lifecycle/CounterpartyInvitationProofLifecycle',
) {}

export const unavailableCounterpartyInvitationProofLifecycle = (
  reason = 'Invitation proof issuance or delivery is unavailable',
): CounterpartyInvitationProofLifecycleService => {
  const unavailable = () =>
    Effect.fail(
      new CounterpartyAccessUnavailable({ code: 'counterparty_access_unavailable', reason }),
    );
  return Object.freeze({
    issueAndStageDelivery: unavailable,
    rotateAndStageDelivery: unavailable,
  });
};
