import { PrincipalIdSchema } from '@app/core-runtime/access/ids';
import { Option, Schema } from 'effect';
import { MembershipSnapshotCompletenessContractSchema } from './customer-group-membership-snapshot.ts';
import { MembershipSourceManagerSchema, MembershipSourceRouteSchema } from './customer-group-membership-source.ts';
import { CustomerProfileSourceAuthoritySchema } from './customer-profile-source.ts';
import { CustomerGroupDefinitionSourceSchema } from './group-contract.ts';
import { SavedAddressSourceAssertionSchema } from './saved-address-source.ts';

/**
 * One owner-side source route: it binds an exact issuer and namespace to the one enrolled principal that
 * may act for them through this route revision. Each variant carries exactly the facts the owner
 * routines of its registry compare at runtime; none of them is defaulted or inferred.
 */
export const CustomerProfileSourceRouteSchema = Schema.TaggedStruct('PROFILE', {
  ...CustomerProfileSourceAuthoritySchema.fields,
  active: Schema.Boolean,
  principalId: PrincipalIdSchema,
  sourceReaderPrincipalIds: Schema.Array(PrincipalIdSchema).check(
    Schema.isMaxLength(32),
    Schema.makeFilter((readers) =>
      new Set(readers.map((reader) => reader.toLowerCase())).size === readers.length
        ? undefined
        : 'Source reader principals must be distinct',
    ),
  ),
});
export const CustomerGroupDefinitionSourceRouteSchema = Schema.TaggedStruct('GROUP_DEFINITION', {
  active: Schema.Boolean,
  issuer: CustomerGroupDefinitionSourceSchema.fields.issuer,
  mappingRevision: CustomerGroupDefinitionSourceSchema.fields.mappingRevision,
  namespace: CustomerGroupDefinitionSourceSchema.fields.namespace,
  principalId: PrincipalIdSchema,
  route: CustomerGroupDefinitionSourceSchema.fields.route,
});
export const CustomerGroupMembershipSourceRouteSchema = Schema.TaggedStruct('MEMBERSHIP', {
  active: Schema.Boolean,
  allowComplete: Schema.Boolean,
  completenessContract: Schema.OptionFromNullOr(MembershipSnapshotCompletenessContractSchema),
  issuer: MembershipSourceManagerSchema.fields.issuer,
  principalId: PrincipalIdSchema,
  route: MembershipSourceRouteSchema,
  sourceNamespace: MembershipSourceManagerSchema.fields.sourceNamespace,
}).check(
  Schema.makeFilter((route) =>
    !route.allowComplete || Option.isSome(route.completenessContract)
      ? undefined
      : 'Complete Membership snapshots require an explicit exact completeness contract',
  ),
);
const SavedAddressSourceKeySchema = SavedAddressSourceAssertionSchema.fields.mappingRevision;
export const SavedAddressSourceRouteSchema = Schema.TaggedStruct('SAVED_ADDRESS', {
  active: Schema.Boolean,
  issuer: SavedAddressSourceKeySchema,
  mappingRevision: SavedAddressSourceKeySchema,
  namespace: SavedAddressSourceKeySchema,
  principalId: PrincipalIdSchema,
  recordType: SavedAddressSourceKeySchema,
  route: Schema.Struct({ id: SavedAddressSourceKeySchema, revision: SavedAddressSourceKeySchema }),
});
export const CustomerSourceRouteSchema = Schema.Union([
  CustomerProfileSourceRouteSchema,
  CustomerGroupDefinitionSourceRouteSchema,
  CustomerGroupMembershipSourceRouteSchema,
  SavedAddressSourceRouteSchema,
]);
export type CustomerSourceRoute = typeof CustomerSourceRouteSchema.Type;

const CustomerSourceRouteReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000));

/**
 * `expected` is the exact current route the operator last read, or none when the route must not exist
 * yet. Anything else, including an expected route of another registry entry, is an expectation mismatch.
 */
export const ConfigureCustomerSourceRoutePayloadSchema = Schema.Struct({
  expected: Schema.OptionFromNullOr(CustomerSourceRouteSchema),
  reason: CustomerSourceRouteReasonSchema,
  route: CustomerSourceRouteSchema,
});
export type ConfigureCustomerSourceRoutePayload = typeof ConfigureCustomerSourceRoutePayloadSchema.Type;

export const ConfigureCustomerSourceRouteResultSchema = Schema.Union([
  Schema.TaggedStruct('CONFIGURED', { route: CustomerSourceRouteSchema }),
  Schema.TaggedStruct('UNCHANGED', { route: CustomerSourceRouteSchema }),
  Schema.TaggedStruct('REJECTED', {
    actual: Schema.OptionFromNullOr(CustomerSourceRouteSchema),
    reason: Schema.Literals(['EXPECTATION_MISMATCH', 'SOURCE_IDENTITY_IMMUTABLE']),
  }),
]);
export type ConfigureCustomerSourceRouteResult = typeof ConfigureCustomerSourceRouteResultSchema.Type;

export const CustomerSourceRouteAuditEvidenceSchema = Schema.Struct({
  outcome: Schema.Literals(['CONFIGURED', 'UNCHANGED', 'EXPECTATION_MISMATCH', 'SOURCE_IDENTITY_IMMUTABLE']),
  reason: CustomerSourceRouteReasonSchema,
  routeKind: Schema.Literals(['PROFILE', 'GROUP_DEFINITION', 'MEMBERSHIP', 'SAVED_ADDRESS']),
});

export class CustomerSourceRouteUnavailable extends Schema.TaggedError<CustomerSourceRouteUnavailable>()(
  'CustomerSourceRouteUnavailable',
  {
    code: Schema.Literal('PERSISTENCE_UNAVAILABLE'),
    reason: Schema.String,
  },
) {}
