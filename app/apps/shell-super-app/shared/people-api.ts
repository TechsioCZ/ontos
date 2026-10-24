/* oxlint-disable effect-native/no-nullable-schema-field -- These are JSON transport codecs matching Core encoding; Core owns Option-based domain absence; remove-when: transport contracts use Option wire codecs. */
import { Schema } from 'effect';

/** JSON transport only. Core remains the owner of membership and authorization rules. */
const uuid = Schema.String.check(Schema.isUUID());
const PrincipalId = uuid.pipe(Schema.brand('PeoplePrincipalId'), Schema.decodeTo(Schema.String));
const TenantId = uuid.pipe(Schema.brand('PeopleTenantId'), Schema.decodeTo(Schema.String));
const LegalEntityId = uuid.pipe(Schema.brand('PeopleLegalEntityId'), Schema.decodeTo(Schema.String));
const InvitationId = uuid.pipe(Schema.brand('PeopleInvitationId'), Schema.decodeTo(Schema.String));
const Affiliation = Schema.Literals(['employee', 'external']);
const RoleOperation = Schema.Literals(['assign', 'revoke']);
const text = (max: number) => Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(max));
export const PeoplePrincipalRefSchema = Schema.Struct({ principalId: PrincipalId, tenantId: TenantId });
export const PeopleScopeSchema = Schema.Union([
  Schema.TaggedStruct('tenant', {}),
  Schema.TaggedStruct('company', { legalEntityId: LegalEntityId }),
]);
export const CompanyAffiliationSchema = Schema.NullOr(Affiliation);
export const CompanyMembershipStatusSchema = Schema.Literals(['invited', 'active', 'disabled', 'departed']);
export const PeopleRoleSchema = Schema.Struct({
  roleKey: text(200),
  scope: PeopleScopeSchema,
  tenantId: TenantId,
});
export const PeopleRoleCatalogSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      name: Schema.String,
      roleKey: text(200),
      scope: PeopleScopeSchema,
    }),
  ),
});
export type PeopleRoleCatalog = typeof PeopleRoleCatalogSchema.Type;
export const PeopleCompanyMembershipSchema = Schema.Struct({
  affiliation: CompanyAffiliationSchema,
  legalEntityId: LegalEntityId,
  principalRef: PeoplePrincipalRefSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  status: CompanyMembershipStatusSchema,
});
export const PeopleListRequestSchema = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 })),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const PeopleInvitationDeliverySchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('pending') }),
  Schema.Struct({ status: Schema.Literal('sent') }),
  Schema.Struct({ status: Schema.Literal('unknown') }),
  Schema.Struct({
    reason: Schema.Literals(['recipient_unavailable', 'rejected', 'retry_expired', 'invitation_expired']),
    status: Schema.Literal('undeliverable'),
  }),
]);
export const PeopleListResponseSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      displayName: Schema.String,
      invitationDelivery: Schema.NullOr(PeopleInvitationDeliverySchema),
      kind: Schema.Literals(['human', 'agent']),
      principalRef: PeoplePrincipalRefSchema,
      principalStatus: Schema.Literals(['active', 'disabled', 'archived']),
      roleAssignments: Schema.Array(PeopleRoleSchema),
      selectedCompanyMembership: Schema.NullOr(PeopleCompanyMembershipSchema),
      selectedCompanyMembershipProjection: Schema.NullOr(
        Schema.Struct({ expectedMember: Schema.Boolean, observedMember: Schema.Boolean }),
      ),
    }),
  ),
  nextOffset: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  scope: PeopleScopeSchema,
  tenantId: TenantId,
});
export const SetPeopleCompanyMembershipRequestSchema = Schema.Struct({
  affiliation: CompanyAffiliationSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  principalRef: PeoplePrincipalRefSchema,
  reason: text(500),
  status: CompanyMembershipStatusSchema,
});
export const SetPeopleCompanyMembershipResponseSchema = Schema.Struct({
  membership: PeopleCompanyMembershipSchema,
  projection: Schema.Literal('pending'),
});
export const SetPeopleRoleRequestSchema = Schema.Struct({
  operation: RoleOperation,
  principalRef: PeoplePrincipalRefSchema,
  reason: text(500),
  roleKey: text(200),
});
export const SetPeopleRoleResponseSchema = Schema.Struct({
  operation: RoleOperation,
  principalRef: PeoplePrincipalRefSchema,
  projection: Schema.Literal('pending'),
  role: PeopleRoleSchema,
});
export const InvitePeopleRequestSchema = Schema.Struct({
  affiliation: Affiliation,
  displayName: text(200),
  email: Schema.Trim.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u), Schema.isMaxLength(254)),
});
export const InvitePeopleResponseSchema = Schema.Struct({
  delivery: Schema.Literal('pending'),
  invitationId: InvitationId,
  membership: PeopleCompanyMembershipSchema,
  principalRef: PeoplePrincipalRefSchema,
});
export type InvitePeopleRequest = typeof InvitePeopleRequestSchema.Type;
export type InvitePeopleResponse = typeof InvitePeopleResponseSchema.Type;
export type PeopleListRequest = typeof PeopleListRequestSchema.Type;
export type PeopleList = typeof PeopleListResponseSchema.Type;
export type Person = PeopleList['items'][number];
export type PeopleScope = typeof PeopleScopeSchema.Type;
export type SetPeopleCompanyMembershipRequest = typeof SetPeopleCompanyMembershipRequestSchema.Type;
export type SetPeopleCompanyMembershipResponse = typeof SetPeopleCompanyMembershipResponseSchema.Type;
export type SetPeopleRoleRequest = typeof SetPeopleRoleRequestSchema.Type;
export type SetPeopleRoleResponse = typeof SetPeopleRoleResponseSchema.Type;
export const PEOPLE_PATHS = {
  companyInvite: '/auth/identity/people/invite',
  companyList: '/auth/identity/people/list',
  companyMembership: '/auth/identity/people/company-membership',
  companyRole: '/auth/identity/people/company-role',
  companyRoleCatalog: '/auth/identity/people/role-catalog',
  tenantList: '/auth/identity/people/tenant-list',
  tenantRole: '/auth/identity/people/tenant-role',
  tenantRoleCatalog: '/auth/identity/people/tenant-role-catalog',
} as const;
