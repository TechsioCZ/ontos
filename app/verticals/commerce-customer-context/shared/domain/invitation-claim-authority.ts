import { Context, Effect } from 'effect';
import type {
  CounterpartyPermissionScope,
  CounterpartyRef,
  PrincipalRef,
} from './access-contract.ts';
import type { CounterpartyAccessDomainError } from './access-error.ts';
import { CounterpartyAccessUnavailable } from './counterparty-access-unavailable.ts';
import type {
  InvitationClaimProofReference,
  VerifiedInvitationClaimAttestation,
} from './invitation-contract.ts';
import type { CounterpartyPermissionCode } from './permission-catalog.ts';
import type { CounterpartyAccessInvitationRef } from '../resources/counterparty-access-invitation.ts';

/** Trusted, transaction-local one-time proof consumption boundary. */
export interface CounterpartyInvitationClaimAuthorityService {
  readonly verifyAndConsume: (input: {
    readonly actionInvocationId: string;
    readonly claimant: PrincipalRef;
    readonly claimProofReference: InvitationClaimProofReference;
    readonly counterpartyRef: CounterpartyRef;
    readonly intendedPermissions: readonly CounterpartyPermissionCode[];
    readonly invitationRef: CounterpartyAccessInvitationRef;
    readonly inviter: PrincipalRef;
    readonly legalEntityId: string;
    readonly scope: CounterpartyPermissionScope;
  }) => Effect.Effect<VerifiedInvitationClaimAttestation, CounterpartyAccessDomainError>;
}

export class CounterpartyInvitationClaimAuthority extends Context.Service<
  CounterpartyInvitationClaimAuthority,
  CounterpartyInvitationClaimAuthorityService
>()(
  '@app/commerce-customer-context/shared/domain/invitation-claim-authority/CounterpartyInvitationClaimAuthority',
) {}

export const unavailableCounterpartyInvitationClaimAuthority = (
  reason = 'Invitation claim proof or inviter authority cannot be verified',
): CounterpartyInvitationClaimAuthorityService =>
  Object.freeze({
    verifyAndConsume: () =>
      Effect.fail(
        new CounterpartyAccessUnavailable({ code: 'counterparty_access_unavailable', reason }),
      ),
  });
