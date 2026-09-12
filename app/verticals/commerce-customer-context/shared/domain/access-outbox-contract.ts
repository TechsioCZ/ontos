import { Schema } from 'effect';
import {
  AccessInstantSchema,
  CounterpartyPermissionScopeSchema,
  CounterpartyRefSchema,
  PrincipalRefSchema,
} from './access-contract.ts';
import {
  CounterpartyAccessInvitationDeliveryMethodSchema,
  InvitationClaimProofReferenceSchema,
  InvitationGrantProgressSchema,
} from './invitation-contract.ts';
import { CounterpartyPermissionCodeSchema } from './permission-catalog.ts';
import { CounterpartyAccessInvitationRefSchema } from '../resources/counterparty-access-invitation.ts';
import { CounterpartyCommerceAccessGrantRefSchema } from '../resources/counterparty-commerce-access-grant.ts';

const revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const accessGrantEventFields = {
  catalogVersion: Schema.Literal('1'),
  counterpartyRef: CounterpartyRefSchema,
  grantRef: CounterpartyCommerceAccessGrantRefSchema,
  permission: CounterpartyPermissionCodeSchema,
  recipient: PrincipalRefSchema,
  revision,
  scope: CounterpartyPermissionScopeSchema,
} as const;

export const CounterpartyAccessGrantedEventPayloadSchema = Schema.Struct({
  ...accessGrantEventFields,
  grantedAt: AccessInstantSchema,
  grantedBy: PrincipalRefSchema,
});

export const CounterpartyAccessRevokedEventPayloadSchema = Schema.Struct({
  ...accessGrantEventFields,
  revokedAt: AccessInstantSchema,
  revokedBy: PrincipalRefSchema,
});

export const CounterpartyAccessAdministratorBootstrappedEventPayloadSchema = Schema.Struct({
  ...accessGrantEventFields,
  bootstrappedAt: AccessInstantSchema,
  bootstrappedBy: PrincipalRefSchema,
});

const invitationEventFields = {
  catalogVersion: Schema.Literal('1'),
  counterpartyRef: CounterpartyRefSchema,
  invitationRef: CounterpartyAccessInvitationRefSchema,
  revision,
  scope: CounterpartyPermissionScopeSchema,
} as const;

export const CounterpartyAccessInvitationCreatedEventPayloadSchema = Schema.Struct({
  ...invitationEventFields,
  createdAt: AccessInstantSchema,
  deliveryMethod: CounterpartyAccessInvitationDeliveryMethodSchema,
  deliveryReference: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  expiresAt: AccessInstantSchema,
  intendedPermissions: Schema.Array(CounterpartyPermissionCodeSchema),
  invitedBy: PrincipalRefSchema,
});

export const CounterpartyAccessInvitationResentEventPayloadSchema = Schema.Struct({
  ...invitationEventFields,
  deliveryMethod: CounterpartyAccessInvitationDeliveryMethodSchema,
  deliveryReference: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  expiresAt: AccessInstantSchema,
  resentBy: PrincipalRefSchema,
});

export const CounterpartyAccessInvitationRevokedEventPayloadSchema = Schema.Struct({
  ...invitationEventFields,
  revokedBy: PrincipalRefSchema,
});

export const CounterpartyAccessInvitationClaimedEventPayloadSchema = Schema.Struct({
  ...invitationEventFields,
  attestationReference: InvitationClaimProofReferenceSchema,
  claimedBy: PrincipalRefSchema,
  grantProgress: Schema.Array(InvitationGrantProgressSchema),
  intendedPermissions: Schema.Array(CounterpartyPermissionCodeSchema),
  verifiedAt: AccessInstantSchema,
});
