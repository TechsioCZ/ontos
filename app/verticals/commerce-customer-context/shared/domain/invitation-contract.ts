import { Schema } from 'effect';
import {
  AccessInstantSchema,
  CounterpartyPermissionScopeSchema,
  CounterpartyRefSchema,
  PrincipalRefSchema,
} from './access-contract.ts';
import { CounterpartyPermissionCodeSchema } from './permission-catalog.ts';
import { CounterpartyAccessInvitationRefSchema } from '../resources/counterparty-access-invitation.ts';
import { CounterpartyCommerceAccessGrantRefSchema } from '../resources/counterparty-commerce-access-grant.ts';

const boundedText = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const safeReference = boundedText.pipe(
  Schema.brand('CounterpartyInvitationSafeReference'),
  Schema.decodeTo(Schema.String),
);

export const InvitationClaimProofReferenceSchema = safeReference;
export type InvitationClaimProofReference = typeof InvitationClaimProofReferenceSchema.Type;

const CounterpartyAccessInvitationStateSchema = Schema.Literals([
  'PENDING',
  'CLAIMING',
  'CLAIMED',
  'REVOKED',
  'EXPIRED',
  'RECONCILIATION_REQUIRED',
]);
export type CounterpartyAccessInvitationState = typeof CounterpartyAccessInvitationStateSchema.Type;

export const CounterpartyAccessInvitationDeliveryMethodSchema = Schema.Literals([
  'VERIFIED_CONTACT_POINT',
  'APPROVED_RECIPIENT_DISCOVERY',
]);

export const VerifiedInvitationClaimAttestationSchema = Schema.Struct({
  attestationReference: safeReference,
  claimant: PrincipalRefSchema,
  counterpartyRef: CounterpartyRefSchema,
  invitationRef: CounterpartyAccessInvitationRefSchema,
  inviterAuthority: Schema.Struct({
    decision: Schema.Literal('ALLOWED'),
    inviter: PrincipalRefSchema,
    permission: Schema.Literal('counterparty.access.manage'),
    scope: CounterpartyPermissionScopeSchema,
  }),
  proofVersion: Schema.Literal('commerce-invitation-proof.v1'),
  state: Schema.Literal('VERIFIED_AND_CONSUMED'),
  verifiedAt: AccessInstantSchema,
});
export type VerifiedInvitationClaimAttestation = typeof VerifiedInvitationClaimAttestationSchema.Type;

export const InvitationGrantProgressSchema = Schema.Union([
  Schema.Struct({
    permission: CounterpartyPermissionCodeSchema,
    state: Schema.Literal('PENDING_GRANT'),
  }),
  Schema.Struct({
    grantRef: CounterpartyCommerceAccessGrantRefSchema,
    permission: CounterpartyPermissionCodeSchema,
    state: Schema.Literals(['ACTIVE', 'RECONCILIATION_REQUIRED']),
  }),
]);
export type InvitationGrantProgress = typeof InvitationGrantProgressSchema.Type;

const hasUniquePermissions = (permissions: readonly (typeof CounterpartyPermissionCodeSchema.Type)[]): boolean =>
  permissions.length > 0 && new Set(permissions).size === permissions.length;

const progressHasExactCoverage = (
  intendedPermissions: readonly (typeof CounterpartyPermissionCodeSchema.Type)[],
  progress: readonly InvitationGrantProgress[],
): boolean => {
  const intendedPermissionSet = new Set(intendedPermissions);
  return (
    progress.length === intendedPermissions.length &&
    new Set(progress.map(({ permission }) => permission)).size === progress.length &&
    progress.every(({ permission }) => intendedPermissionSet.has(permission))
  );
};

const completionState = (
  intendedPermissions: readonly (typeof CounterpartyPermissionCodeSchema.Type)[],
  progress: readonly InvitationGrantProgress[],
): CounterpartyAccessInvitationState => {
  if (!hasUniquePermissions(intendedPermissions) || !progressHasExactCoverage(intendedPermissions, progress)) {
    return 'RECONCILIATION_REQUIRED';
  }
  if (progress.some(({ state }) => state === 'RECONCILIATION_REQUIRED')) {
    return 'RECONCILIATION_REQUIRED';
  }
  return progress.every(({ state }) => state === 'ACTIVE') ? 'CLAIMED' : 'CLAIMING';
};

const unclaimedInvitationIssue = (
  invitation: CounterpartyAccessInvitation,
  hasNoProgress: boolean,
): string | undefined =>
  hasNoProgress && invitation.claimant === undefined
    ? undefined
    : 'an unclaimed invitation cannot contain a claimant or grant progress';

const revokedInvitationIssue = (hasNoProgress: boolean, hasExactProgress: boolean): string | undefined =>
  hasNoProgress || hasExactProgress
    ? undefined
    : 'a revoked invitation must preserve no progress or exact intended Permission progress';

const claimedInvitationIssue = (
  invitation: CounterpartyAccessInvitation,
  hasExactProgress: boolean,
): string | undefined => {
  if (invitation.claimant === undefined || !hasExactProgress) {
    return 'a claimed or claiming invitation requires one exact progress item per intended Permission';
  }
  return completionState(invitation.intendedPermissions, invitation.grantProgress) === invitation.state
    ? undefined
    : 'invitation lifecycle state must match its exact grant completion state';
};

export const CounterpartyAccessInvitationSchema = Schema.Struct({
  catalogVersion: Schema.Literal('1'),
  claimant: Schema.optionalKey(PrincipalRefSchema),
  claimProofVersion: Schema.Literal('commerce-invitation-proof.v1'),
  counterpartyRef: CounterpartyRefSchema,
  createdAt: AccessInstantSchema,
  deliveryMethod: CounterpartyAccessInvitationDeliveryMethodSchema,
  deliveryReference: boundedText,
  expiresAt: AccessInstantSchema,
  grantProgress: Schema.Array(InvitationGrantProgressSchema),
  intendedPermissions: Schema.Array(CounterpartyPermissionCodeSchema),
  invitationRef: CounterpartyAccessInvitationRefSchema,
  invitedBy: PrincipalRefSchema,
  reason: boundedText,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  scope: CounterpartyPermissionScopeSchema,
  state: CounterpartyAccessInvitationStateSchema,
}).check(Schema.makeFilter(invitationValidationIssue)); // oxlint-disable-line eslint/no-use-before-define -- The schema-derived validator type requires this intentionally hoisted declaration.
export type CounterpartyAccessInvitation = typeof CounterpartyAccessInvitationSchema.Type;

// oxlint-disable-next-line eslint/func-style -- This validator is intentionally hoisted for the schema declaration above.
function invitationValidationIssue(invitation: CounterpartyAccessInvitation): string | undefined {
  if (!hasUniquePermissions(invitation.intendedPermissions)) {
    return 'an invitation must contain a non-empty unique intended Permission set';
  }
  const hasNoProgress = invitation.grantProgress.length === 0;
  if (invitation.state === 'PENDING' || invitation.state === 'EXPIRED') {
    return unclaimedInvitationIssue(invitation, hasNoProgress);
  }
  const hasExactProgress = progressHasExactCoverage(invitation.intendedPermissions, invitation.grantProgress);
  if (invitation.state === 'REVOKED') {
    return revokedInvitationIssue(hasNoProgress, hasExactProgress);
  }
  return claimedInvitationIssue(invitation, hasExactProgress);
}

export const invitationHasUniquePermissions = (
  permissions: readonly (typeof CounterpartyPermissionCodeSchema.Type)[],
): boolean => hasUniquePermissions(permissions);

export const invitationCanBeResent = (invitation: CounterpartyAccessInvitation, now: string): boolean =>
  invitation.state === 'PENDING' && now < invitation.expiresAt;

export const invitationCanBeRevoked = (invitation: CounterpartyAccessInvitation): boolean =>
  invitation.state === 'PENDING' || invitation.state === 'CLAIMING' || invitation.state === 'RECONCILIATION_REQUIRED';

export const invitationCanBeginClaim = (invitation: CounterpartyAccessInvitation, now: string): boolean =>
  invitation.state === 'PENDING' && now < invitation.expiresAt;

export const invitationCompletionState = (
  intendedPermissions: readonly (typeof CounterpartyPermissionCodeSchema.Type)[],
  progress: readonly InvitationGrantProgress[],
): CounterpartyAccessInvitationState => completionState(intendedPermissions, progress);

const invitationTransitions = Object.freeze({
  CLAIMED: Object.freeze([]),
  CLAIMING: Object.freeze(['CLAIMED', 'RECONCILIATION_REQUIRED', 'REVOKED']),
  EXPIRED: Object.freeze([]),
  PENDING: Object.freeze(['CLAIMING', 'EXPIRED', 'REVOKED']),
  RECONCILIATION_REQUIRED: Object.freeze(['CLAIMING', 'CLAIMED', 'REVOKED']),
  REVOKED: Object.freeze([]),
} satisfies Readonly<Record<CounterpartyAccessInvitationState, readonly CounterpartyAccessInvitationState[]>>);

export const invitationCanTransition = (
  from: CounterpartyAccessInvitationState,
  to: CounterpartyAccessInvitationState,
): boolean => from === to || invitationTransitions[from].some((candidate) => candidate === to);
