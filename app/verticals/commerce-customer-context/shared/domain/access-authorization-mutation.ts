import { Schema } from 'effect';
import { CounterpartyRefSchema, CounterpartyPermissionScopeSchema } from './access-contract.ts';
import { CounterpartyPermissionCodeSchema } from './permission-catalog.ts';
import { CounterpartyAccessInvitationRefSchema } from '../resources/counterparty-access-invitation.ts';
import { CounterpartyCommerceAccessGrantRefSchema } from '../resources/counterparty-commerce-access-grant.ts';

const uuid = Schema.String.check(Schema.isUUID()).pipe(Schema.decodeTo(Schema.String));

const AccessAuthorizationMutationIdSchema = uuid.pipe(
  Schema.brand('AccessAuthorizationMutationId'),
  Schema.decodeTo(Schema.String),
);
type AccessAuthorizationMutationId = typeof AccessAuthorizationMutationIdSchema.Type;

export const AccessAuthorizationMutationEvidenceSchema = Schema.Struct({
  mutationId: AccessAuthorizationMutationIdSchema,
  operation: Schema.Literals(['grant', 'revoke']),
  staged: Schema.Boolean,
});
export type AccessAuthorizationMutationEvidence = typeof AccessAuthorizationMutationEvidenceSchema.Type;

const InvitationPermissionAuthorizationMutationSchema = Schema.Struct({
  grantRef: CounterpartyCommerceAccessGrantRefSchema,
  mutationId: AccessAuthorizationMutationIdSchema,
  operation: Schema.Literal('grant'),
  permission: CounterpartyPermissionCodeSchema,
  staged: Schema.Boolean,
});

const hasUniquePermissionMutationIdentities = (
  mutations: readonly {
    readonly grantRef: typeof CounterpartyCommerceAccessGrantRefSchema.Type;
    readonly mutationId: AccessAuthorizationMutationId;
    readonly permission: typeof CounterpartyPermissionCodeSchema.Type;
  }[],
): boolean => {
  const ids = mutations.map(({ mutationId }) => mutationId);
  const grants = mutations.map(({ grantRef }) => `${grantRef.tenantId}:${grantRef.resourceId}`);
  const permissions = mutations.map(({ permission }) => permission);
  return (
    new Set(ids).size === ids.length &&
    new Set(grants).size === grants.length &&
    new Set(permissions).size === permissions.length
  );
};

export const InvitationClaimAuthorizationMutationEvidenceSchema = Schema.Struct({
  mutationId: AccessAuthorizationMutationIdSchema,
  operation: Schema.Literal('claim'),
  permissionMutations: Schema.Array(InvitationPermissionAuthorizationMutationSchema).check(
    Schema.isMaxLength(15),
    Schema.makeFilter((mutations) =>
      hasUniquePermissionMutationIdentities(mutations)
        ? undefined
        : 'claim authorization mutations must have unique mutation, grant, and Permission identities',
    ),
  ),
  staged: Schema.Boolean,
});
export type InvitationClaimAuthorizationMutationEvidence =
  typeof InvitationClaimAuthorizationMutationEvidenceSchema.Type;

const requestedFields = {
  catalogVersion: Schema.Literal('1'),
  counterpartyRef: CounterpartyRefSchema,
  legalEntityId: uuid,
  mutationId: AccessAuthorizationMutationIdSchema,
  schemaVersion: Schema.Literal('1'),
} as const;

const directRequestedFields = {
  ...requestedFields,
  grantRef: CounterpartyCommerceAccessGrantRefSchema,
} as const;

const exactDirectTenant = <
  Value extends {
    readonly counterpartyRef: { readonly tenantId: string };
    readonly grantRef: { readonly tenantId: string };
  },
>(
  value: Value,
) =>
  value.counterpartyRef.tenantId === value.grantRef.tenantId
    ? undefined
    : 'authorization mutation references must share one Tenant';

export const CounterpartyAccessGrantAuthorizationMutationRequestedPayloadSchema = Schema.Struct({
  ...directRequestedFields,
  operation: Schema.Literal('grant'),
}).check(Schema.makeFilter(exactDirectTenant));
export type CounterpartyAccessGrantAuthorizationMutationRequestedPayload =
  typeof CounterpartyAccessGrantAuthorizationMutationRequestedPayloadSchema.Type;

export const CounterpartyAccessRevokeAuthorizationMutationRequestedPayloadSchema = Schema.Struct({
  ...directRequestedFields,
  operation: Schema.Literal('revoke'),
}).check(Schema.makeFilter(exactDirectTenant));
export type CounterpartyAccessRevokeAuthorizationMutationRequestedPayload =
  typeof CounterpartyAccessRevokeAuthorizationMutationRequestedPayloadSchema.Type;

export { CounterpartyAccessGrantAuthorizationMutationRequestedPayloadSchema as CounterpartyAccessAdministratorBootstrapAuthorizationMutationRequestedPayloadSchema };

export const CounterpartyAccessInvitationClaimAuthorizationMutationRequestedPayloadSchema = Schema.Struct({
  ...requestedFields,
  invitationRef: CounterpartyAccessInvitationRefSchema,
  operation: Schema.Literal('claim'),
  permissionMutations: Schema.Array(
    Schema.Struct({
      grantRef: CounterpartyCommerceAccessGrantRefSchema,
      mutationId: AccessAuthorizationMutationIdSchema,
      operation: Schema.Literal('grant'),
      permission: CounterpartyPermissionCodeSchema,
    }),
  ).check(
    Schema.isMaxLength(15),
    Schema.makeFilter((mutations) =>
      hasUniquePermissionMutationIdentities(mutations)
        ? undefined
        : 'claim request must contain unique mutation, grant, and Permission identities',
    ),
  ),
  scope: CounterpartyPermissionScopeSchema,
}).check(
  Schema.makeFilter(({ counterpartyRef, invitationRef, permissionMutations }) =>
    invitationRef.tenantId === counterpartyRef.tenantId &&
    permissionMutations.every(({ grantRef }) => grantRef.tenantId === counterpartyRef.tenantId)
      ? undefined
      : 'invitation claim mutation references must share one Tenant',
  ),
);
export type CounterpartyAccessInvitationClaimAuthorizationMutationRequestedPayload =
  typeof CounterpartyAccessInvitationClaimAuthorizationMutationRequestedPayloadSchema.Type;
