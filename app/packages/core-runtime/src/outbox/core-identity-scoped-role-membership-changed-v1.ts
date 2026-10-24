import { Match, Schema } from 'effect';

import { CompanyMembershipSchema } from '../permissions/company-membership.ts';
import { PrincipalRefSchema } from '../permissions/principal-ref.ts';
import { toScopedRoleObjectId } from '../permissions/scoped-role.ts';
import type { ScopedRoleIdentity } from '../permissions/scoped-role.ts';

export const ScopedRoleKeySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^\S(?:.*\S)?$/u),
).pipe(Schema.brand('ScopedRoleKey'), Schema.decodeTo(Schema.String));
export const ScopedRoleMembershipOperationSchema = Schema.Literals(['assign', 'revoke']);
export const ScopedRoleMembershipReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
  Schema.isPattern(/\S/u),
);

// Both decoded and encoded event/audit values must be JSON. A tagged scope carries
// explicit tenant intent without introducing nulls or decoded Effect Options.
export const ScopedRoleScopeSchema = Schema.Union([
  Schema.TaggedStruct('tenant', {}),
  Schema.TaggedStruct('company', { legalEntityId: CompanyMembershipSchema.fields.legalEntityId }),
]);
export const ScopedRoleMembershipRoleSchema = Schema.Struct({
  roleKey: ScopedRoleKeySchema,
  scope: ScopedRoleScopeSchema,
  tenantId: PrincipalRefSchema.fields.tenantId,
});
export type ScopedRoleMembershipRole = typeof ScopedRoleMembershipRoleSchema.Type;

export const scopedRoleIdentity = (role: ScopedRoleMembershipRole): ScopedRoleIdentity =>
  Match.value(role.scope).pipe(
    Match.tagsExhaustive({
      company: ({ legalEntityId }) => ({ legalEntityId, roleKey: role.roleKey, tenantId: role.tenantId }),
      tenant: () => ({ roleKey: role.roleKey, tenantId: role.tenantId }),
    }),
  );

/** Durable audit of an explicit command, not a desired-policy table. SpiceDB remains live authority. */
export const ScopedRoleMembershipAuditEvidenceSchema = Schema.Struct({
  operation: ScopedRoleMembershipOperationSchema,
  principalRef: PrincipalRefSchema,
  reason: ScopedRoleMembershipReasonSchema,
  role: ScopedRoleMembershipRoleSchema,
});

/** Identity-only wake-up. A delayed delivery never replays its old assign/revoke operation. */
export const OutboxPayloadSchema = Schema.Struct({
  data: Schema.Struct({
    principalId: PrincipalRefSchema.fields.principalId,
    roleKey: ScopedRoleKeySchema,
    scope: ScopedRoleScopeSchema,
  }),
});
export type OutboxPayload = typeof OutboxPayloadSchema.Type;
export const outboxTopic = 'core.identity.scoped-role-membership-changed.v1';
export const outboxProducerModuleKey = 'core.identity';
export const scopedRoleMembershipSubjectId = (role: ScopedRoleIdentity, principalId: string): string =>
  `${toScopedRoleObjectId(role)}.${principalId}`;
