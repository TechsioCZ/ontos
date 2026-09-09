import { Context } from 'effect';
import type { Effect, Redacted } from 'effect';
import type {
  AccessInstant,
  CounterpartyPermissionScope,
  CounterpartyRef,
} from './access-contract.ts';
import type { CounterpartyAccessDomainError } from './access-error.ts';
import type { InvitationClaimProofReference } from './invitation-contract.ts';
import type { CounterpartyPermissionCode } from './permission-catalog.ts';
import type { CounterpartyAccessInvitationRef } from '../resources/counterparty-access-invitation.ts';

export interface CounterpartyInvitationClaimRedemptionService {
  readonly redeem: (input: {
    readonly invitationRef: CounterpartyAccessInvitationRef;
    readonly proofReference: InvitationClaimProofReference;
    readonly rawProof: Redacted.Redacted;
  }) => Effect.Effect<
    Readonly<{
      readonly counterpartyRef: CounterpartyRef;
      readonly expiresAt: AccessInstant;
      readonly intendedPermissions: readonly CounterpartyPermissionCode[];
      readonly invitationRef: CounterpartyAccessInvitationRef;
      readonly proofReference: InvitationClaimProofReference;
      readonly scope: CounterpartyPermissionScope;
    }>,
    CounterpartyAccessDomainError
  >;
}

/**
 * Authenticated enrollment boundary: an implementation MUST bind claimant/Tenant/Legal Entity
 * from a Core-verified OperationalScope, never these caller-supplied proof fields.
 */
export class CounterpartyInvitationClaimRedemption extends Context.Service<
  CounterpartyInvitationClaimRedemption,
  CounterpartyInvitationClaimRedemptionService
>()(
  '@app/commerce-customer-context/shared/domain/invitation-claim-redemption/CounterpartyInvitationClaimRedemption',
) {}
