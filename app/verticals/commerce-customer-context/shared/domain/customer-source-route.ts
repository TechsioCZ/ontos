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

/** The owner's generation of one stored route: every change advances it by one and none is ever reused. */
export const CustomerSourceRouteGenerationSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(2_147_483_647),
);

/** The registry entry one route configuration addresses, whatever the route kind. */
const CustomerSourceRouteIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand('CustomerSourceRouteId'),
);

/**
 * `expectedGeneration` is the generation of the route the administrator last read, or none (null) when the
 * route must not exist yet. Any other stored generation is an expectation mismatch, so a decision taken on a
 * stale view never overwrites a later one.
 */
export const ConfigureCustomerSourceRoutePayloadSchema = Schema.Struct({
  expectedGeneration: Schema.OptionFromNullOr(CustomerSourceRouteGenerationSchema),
  reason: CustomerSourceRouteReasonSchema,
  route: CustomerSourceRouteSchema,
});
export type ConfigureCustomerSourceRoutePayload = typeof ConfigureCustomerSourceRoutePayloadSchema.Type;

/**
 * A refusal names only the stored generation (none when no route is stored): the comparison never depends on a
 * stored route still satisfying today's route contract, so even such a route can be repaired.
 */
export const ConfigureCustomerSourceRouteResultSchema = Schema.Union([
  Schema.TaggedStruct('CONFIGURED', {
    generation: CustomerSourceRouteGenerationSchema,
    route: CustomerSourceRouteSchema,
  }),
  Schema.TaggedStruct('UNCHANGED', {
    generation: CustomerSourceRouteGenerationSchema,
    route: CustomerSourceRouteSchema,
  }),
  Schema.TaggedStruct('REJECTED', {
    currentGeneration: Schema.OptionFromNullOr(CustomerSourceRouteGenerationSchema),
    reason: Schema.Literals(['EXPECTATION_MISMATCH', 'PRINCIPAL_INELIGIBLE', 'SOURCE_IDENTITY_IMMUTABLE']),
  }),
]);
export type ConfigureCustomerSourceRouteResult = typeof ConfigureCustomerSourceRouteResultSchema.Type;

/**
 * The stored generations before and after the decision, each absent when no route was stored; the owner's
 * append-only route history holds the route document, acting principal, Action invocation and reason of every
 * generation.
 */
export const CustomerSourceRouteAuditEvidenceSchema = Schema.Struct({
  currentGeneration: Schema.optionalKey(CustomerSourceRouteGenerationSchema),
  outcome: Schema.Literals([
    'CONFIGURED',
    'UNCHANGED',
    'EXPECTATION_MISMATCH',
    'PRINCIPAL_INELIGIBLE',
    'SOURCE_IDENTITY_IMMUTABLE',
  ]),
  previousGeneration: Schema.optionalKey(CustomerSourceRouteGenerationSchema),
  reason: CustomerSourceRouteReasonSchema,
  routeId: CustomerSourceRouteIdSchema,
  routeKind: Schema.Literals(['PROFILE', 'GROUP_DEFINITION', 'MEMBERSHIP', 'SAVED_ADDRESS']),
});

export class CustomerSourceRouteUnavailable extends Schema.TaggedError<CustomerSourceRouteUnavailable>()(
  'CustomerSourceRouteUnavailable',
  {
    code: Schema.Literal('PERSISTENCE_UNAVAILABLE'),
    reason: Schema.String,
  },
) {}
