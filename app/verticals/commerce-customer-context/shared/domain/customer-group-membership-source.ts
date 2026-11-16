import { Schema } from 'effect';

export const MembershipSourceIdentitySchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
);

export const MembershipSourceOrderSchema = Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }));

export const MembershipSourceManagerSchema = Schema.Struct({
  factFamily: Schema.Literal('CUSTOMER_GROUP_MEMBERSHIP'),
  issuer: MembershipSourceIdentitySchema,
  sourceNamespace: MembershipSourceIdentitySchema,
  tenantId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('MembershipSourceTenantId')),
});

export const MembershipSourceRouteSchema = Schema.Struct({
  id: MembershipSourceIdentitySchema,
  revision: MembershipSourceIdentitySchema,
});

export const MembershipSourceEffectIdSchema = MembershipSourceIdentitySchema.pipe(
  Schema.brand('MembershipSourceEffectId'),
);
const MembershipSourceAssertionIdSchema = MembershipSourceIdentitySchema.pipe(
  Schema.brand('MembershipSourceAssertionId'),
);
const MembershipSourceRecordIdSchema = MembershipSourceIdentitySchema.pipe(Schema.brand('MembershipSourceRecordId'));

export const MembershipSourceAssertionSchema = Schema.Struct({
  assertionId: MembershipSourceAssertionIdSchema,
  effectId: MembershipSourceEffectIdSchema,
  order: MembershipSourceOrderSchema,
  sourceRecordId: MembershipSourceRecordIdSchema,
});

export const CustomerGroupMembershipManagementSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('MANUAL') }),
  Schema.Struct({ kind: Schema.Literal('LEGACY_UNATTRIBUTED') }),
  Schema.Struct({
    kind: Schema.Literal('EXTERNAL_SOURCE'),
    manager: MembershipSourceManagerSchema,
    source: MembershipSourceAssertionSchema,
  }),
]);
