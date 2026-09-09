import { Context, Effect, Schema } from 'effect';
import type {
  AccessInstant,
  CounterpartyAccessDecision,
  CounterpartyAccessGrant,
  CounterpartyPermissionScope,
  CounterpartyRef,
  PrincipalRef,
} from './access-contract.ts';
import type {
  CounterpartyAccessInvitation,
  InvitationClaimProofReference,
  VerifiedInvitationClaimAttestation,
} from './invitation-contract.ts';
import type {
  AccessAuthorizationMutationEvidence,
  InvitationClaimAuthorizationMutationEvidence,
} from './access-authorization-mutation.ts';
import type { CounterpartyPermissionCode } from './permission-catalog.ts';
import type { CounterpartyAccessInvitationRef } from '../resources/counterparty-access-invitation.ts';
import type { CounterpartyCommerceAccessGrantRef } from '../resources/counterparty-commerce-access-grant.ts';
import type { CounterpartyAccessDomainError } from './access-error.ts';
import { CounterpartyAccessUnavailable } from './counterparty-access-unavailable.ts';

export {
  CounterpartyAccessContractViolation,
  CounterpartyAccessDomainErrorSchema,
  CounterpartyAccessUnavailable,
} from './access-error.ts';
export type { CounterpartyAccessDomainError } from './access-error.ts';
export {
  CounterpartyInvitationClaimAuthority,
  unavailableCounterpartyInvitationClaimAuthority,
} from './invitation-claim-authority.ts';
export type { CounterpartyInvitationClaimAuthorityService } from './invitation-claim-authority.ts';
export { CounterpartyInvitationClaimRedemption } from './invitation-claim-redemption.ts';
export type { CounterpartyInvitationClaimRedemptionService } from './invitation-claim-redemption.ts';
export {
  CounterpartyInvitationProofDelivery,
  secureQueuedCounterpartyInvitationProofDelivery,
  unavailableCounterpartyInvitationProofDelivery,
} from './invitation-proof-delivery.ts';
export type {
  CounterpartyInvitationProofDeliveryService,
  CounterpartyInvitationProofSecureQueue,
} from './invitation-proof-delivery.ts';
export {
  CounterpartyInvitationProofLifecycle,
  unavailableCounterpartyInvitationProofLifecycle,
} from './invitation-proof-lifecycle.ts';
export type {
  CounterpartyInvitationProofLifecycleService,
  CounterpartyInvitationProofRegistration,
  CounterpartyInvitationProofRegistrationInput,
} from './invitation-proof-lifecycle.ts';

export interface AccessOperationContext {
  readonly actionInvocationId: string;
  readonly actor: PrincipalRef;
  readonly legalEntityId: string;
}

export interface GrantCounterpartyAccessInput extends AccessOperationContext {
  readonly counterpartyRef: CounterpartyRef;
  readonly permission: CounterpartyPermissionCode;
  readonly reason?: string | undefined;
  readonly recipient: PrincipalRef;
  readonly scope: CounterpartyPermissionScope;
}

export interface RevokeCounterpartyAccessInput extends GrantCounterpartyAccessInput {
  readonly grantRef?: CounterpartyCommerceAccessGrantRef | undefined;
}

export type GrantCounterpartyAccessOutcome =
  | Readonly<{
      readonly grant: CounterpartyAccessGrant;
      readonly outcome: 'APPLIED' | 'ALREADY_ACTIVE' | 'CONFLICT';
    }>
  | Readonly<{
      readonly grant: CounterpartyAccessGrant;
      readonly outcome: 'RECONCILIATION_REQUIRED';
      readonly reconciliation: AccessAuthorizationMutationEvidence & {
        readonly operation: 'grant';
      };
    }>;

export type RevokeCounterpartyAccessOutcome =
  | Readonly<{
      readonly grant: CounterpartyAccessGrant;
      readonly outcome: 'REVOKED' | 'ALREADY_REVOKED' | 'LAST_ADMIN_PROTECTED' | 'SCOPE_MISMATCH';
    }>
  | Readonly<{
      readonly grant: CounterpartyAccessGrant;
      readonly outcome: 'RECONCILIATION_REQUIRED';
      readonly reconciliation: AccessAuthorizationMutationEvidence & {
        readonly operation: 'revoke';
      };
    }>;

export type BootstrapCounterpartyAccessAdministratorOutcome =
  | Readonly<{
      readonly grant: CounterpartyAccessGrant;
      readonly outcome: 'APPLIED' | 'ALREADY_ACTIVE' | 'CONFLICT';
    }>
  | Readonly<{
      readonly grant: CounterpartyAccessGrant;
      readonly outcome: 'RECONCILIATION_REQUIRED';
      readonly reconciliation: AccessAuthorizationMutationEvidence & {
        readonly operation: 'grant';
      };
    }>;

export interface CreateCounterpartyAccessInvitationInput extends AccessOperationContext {
  readonly counterpartyRef: CounterpartyRef;
  readonly deliveryMethod: 'VERIFIED_CONTACT_POINT' | 'APPROVED_RECIPIENT_DISCOVERY';
  readonly deliveryReference: string;
  readonly expiresAt: AccessInstant;
  readonly intendedPermissions: readonly CounterpartyPermissionCode[];
  readonly reason: string;
  readonly scope: CounterpartyPermissionScope;
}

export interface InvitationMutationInput extends AccessOperationContext {
  readonly counterpartyRef: CounterpartyRef;
  readonly expectedRevision: number;
  readonly invitationRef: CounterpartyAccessInvitationRef;
  readonly reason?: string | undefined;
  readonly scope: CounterpartyPermissionScope;
}

export interface ClaimCounterpartyAccessInvitationInput extends InvitationMutationInput {
  readonly claimant: PrincipalRef;
  readonly claimProofReference: InvitationClaimProofReference;
}

export type CreateCounterpartyAccessInvitationOutcome = Readonly<{
  readonly invitation: CounterpartyAccessInvitation;
  readonly outcome: 'CREATED' | 'ALREADY_PENDING';
}>;

export type ResendCounterpartyAccessInvitationOutcome = Readonly<{
  readonly invitation: CounterpartyAccessInvitation;
  readonly outcome: 'RESENT' | 'ALREADY_SENT';
}>;

export type RevokeCounterpartyAccessInvitationOutcome = Readonly<{
  readonly invitation: CounterpartyAccessInvitation;
  readonly outcome: 'REVOKED' | 'ALREADY_REVOKED';
}>;

/**
 * Safe, closed reasons whose proof-attempt evidence must commit before the public Action rejects.
 * Infrastructure and authority-check failures are intentionally absent and remain retryable.
 */
export const InvitationClaimRejectionSchema = Schema.Literals([
  'ALREADY_CONSUMED',
  'EXPIRED',
  'INVALID_PROOF',
  'RATE_LIMITED',
]);
export type InvitationClaimRejection = typeof InvitationClaimRejectionSchema.Type;

export type ClaimCounterpartyAccessInvitationOutcome =
  | Readonly<{
      readonly attestation: VerifiedInvitationClaimAttestation;
      readonly invitation: CounterpartyAccessInvitation;
      readonly outcome: 'CLAIMED';
    }>
  | Readonly<{
      readonly attestation: VerifiedInvitationClaimAttestation;
      readonly invitation: CounterpartyAccessInvitation;
      readonly outcome: 'RECONCILIATION_REQUIRED';
      readonly reconciliation: InvitationClaimAuthorizationMutationEvidence;
    }>
  | Readonly<{
      readonly invitation: CounterpartyAccessInvitation;
      readonly outcome: 'ALREADY_CLAIMED';
    }>
  | Readonly<{
      readonly invitation: CounterpartyAccessInvitation;
      readonly outcome: 'REJECTED';
      readonly rejection: InvitationClaimRejection;
    }>;

export interface CounterpartyAccessPortService {
  readonly bootstrapAdministrator: (
    input: GrantCounterpartyAccessInput,
  ) => Effect.Effect<
    BootstrapCounterpartyAccessAdministratorOutcome,
    CounterpartyAccessDomainError
  >;
  readonly check: (input: {
    readonly counterpartyRef: CounterpartyRef;
    readonly permission: CounterpartyPermissionCode;
    readonly principal: PrincipalRef;
    readonly scope: CounterpartyPermissionScope;
  }) => Effect.Effect<CounterpartyAccessDecision, CounterpartyAccessUnavailable>;
  readonly claimInvitation: (
    input: ClaimCounterpartyAccessInvitationInput,
  ) => Effect.Effect<ClaimCounterpartyAccessInvitationOutcome, CounterpartyAccessDomainError>;
  readonly createInvitation: (
    input: CreateCounterpartyAccessInvitationInput,
  ) => Effect.Effect<CreateCounterpartyAccessInvitationOutcome, CounterpartyAccessDomainError>;
  readonly getInvitation: (input: {
    readonly actor: PrincipalRef;
    readonly counterpartyRef: CounterpartyRef;
    readonly invitationRef: CounterpartyAccessInvitationRef;
    readonly legalEntityId: string;
    readonly scope: CounterpartyPermissionScope;
  }) => Effect.Effect<CounterpartyAccessInvitation, CounterpartyAccessDomainError>;
  readonly grant: (
    input: GrantCounterpartyAccessInput,
  ) => Effect.Effect<GrantCounterpartyAccessOutcome, CounterpartyAccessDomainError>;
  readonly list: (input: {
    readonly actor: PrincipalRef;
    readonly counterpartyRef: CounterpartyRef;
    readonly legalEntityId: string;
    readonly recipient?: PrincipalRef | undefined;
    readonly scope: CounterpartyPermissionScope;
  }) => Effect.Effect<readonly CounterpartyAccessGrant[], CounterpartyAccessDomainError>;
  readonly resendInvitation: (
    input: InvitationMutationInput,
  ) => Effect.Effect<ResendCounterpartyAccessInvitationOutcome, CounterpartyAccessDomainError>;
  readonly revoke: (
    input: RevokeCounterpartyAccessInput,
  ) => Effect.Effect<RevokeCounterpartyAccessOutcome, CounterpartyAccessDomainError>;
  readonly revokeInvitation: (
    input: InvitationMutationInput,
  ) => Effect.Effect<RevokeCounterpartyAccessInvitationOutcome, CounterpartyAccessDomainError>;
}

export class CounterpartyAccessPort extends Context.Service<
  CounterpartyAccessPort,
  CounterpartyAccessPortService
>()('@app/commerce-customer-context/shared/domain/access-port/CounterpartyAccessPort') {}

export const unavailableCounterpartyAccessPort = (
  reason = 'Counterparty Commerce Access is temporarily unavailable',
): CounterpartyAccessPortService => {
  const unavailable = () =>
    Effect.fail(
      new CounterpartyAccessUnavailable({
        code: 'counterparty_access_unavailable',
        reason,
      }),
    );
  return Object.freeze({
    bootstrapAdministrator: unavailable,
    check: unavailable,
    claimInvitation: unavailable,
    createInvitation: unavailable,
    getInvitation: unavailable,
    grant: unavailable,
    list: unavailable,
    resendInvitation: unavailable,
    revoke: unavailable,
    revokeInvitation: unavailable,
  });
};
