import type { Effect, Redacted } from 'effect';
import type { AccessInstant, CounterpartyPermissionScope, CounterpartyRef } from './access-contract.ts';
import type { CounterpartyAccessDomainError } from './access-error.ts';
import type { InvitationClaimProofReference } from './invitation-contract.ts';
import type { CounterpartyPermissionCode } from './permission-catalog.ts';
import type { CounterpartyAccessInvitationRef } from '../resources/counterparty-access-invitation.ts';

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- This exported port contract is implemented and injected by the owner persistence boundary; introducing a Context.Service would change its public lifetime API.
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
