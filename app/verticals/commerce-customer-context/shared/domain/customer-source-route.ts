import { PrincipalIdSchema } from '@app/core-runtime/access/ids';
import { Option, Schema } from 'effect';
import { MembershipSnapshotCompletenessContractSchema } from './customer-group-membership-snapshot.ts';
import { MembershipSourceManagerSchema, MembershipSourceRouteSchema } from './customer-group-membership-source.ts';
import { CustomerProfileSourceAuthoritySchema } from './customer-profile-source.ts';
import { CustomerGroupDefinitionSourceSchema } from './group-contract.ts';
import { SavedAddressSourceAssertionSchema } from './saved-address-source.ts';

/**
 * The integration principals that may read through a route; a reader never writes through it. The owner stores
 * them as a set: at most 32, each once in any letter case, in sorted lower-case form.
 */
const SourceReaderPrincipalIdsSchema = Schema.Array(PrincipalIdSchema).check(
  Schema.isMaxLength(32),
  Schema.makeFilter((readers) =>
    new Set(readers.map((reader) => reader.toLowerCase())).size === readers.length
      ? undefined
      : 'Source reader principals must be distinct',
  ),
);

/**
 * One owner-side source route: it binds an exact issuer and namespace to the one enrolled principal that
 * may act for them through this route revision. Each variant carries exactly the facts the owner
 * routines of its registry compare at runtime; none of them is defaulted or inferred.
 */
export const CustomerProfileSourceRouteSchema = Schema.TaggedStruct('PROFILE', {
  ...CustomerProfileSourceAuthoritySchema.fields,
  active: Schema.Boolean,
  principalId: PrincipalIdSchema,
  sourceReaderPrincipalIds: SourceReaderPrincipalIdsSchema,
});
/** A Group definition reader reads current source definitions only; a receipt is recovered by the writer alone. */
export const CustomerGroupDefinitionSourceRouteSchema = Schema.TaggedStruct('GROUP_DEFINITION', {
  active: Schema.Boolean,
  issuer: CustomerGroupDefinitionSourceSchema.fields.issuer,
  mappingRevision: CustomerGroupDefinitionSourceSchema.fields.mappingRevision,
  namespace: CustomerGroupDefinitionSourceSchema.fields.namespace,
  principalId: PrincipalIdSchema,
  route: CustomerGroupDefinitionSourceSchema.fields.route,
  sourceReaderPrincipalIds: SourceReaderPrincipalIdsSchema,
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

/** The registry entry one route decision addresses, whatever the route kind. */
export const CustomerSourceRouteIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand('CustomerSourceRouteId'),
);
export const CustomerSourceRouteKindSchema = Schema.Literals([
  'PROFILE',
  'GROUP_DEFINITION',
  'MEMBERSHIP',
  'SAVED_ADDRESS',
]);

/**
 * `CONFIGURE` states the whole route; its `expectedGeneration` is the generation of the route the administrator
 * last read, or none (null) when the route must not exist yet. `PAUSE` names only the stored route and the
 * generation read, and changes nothing but its active flag. Any other stored generation is an expectation
 * mismatch, so a decision taken on a stale view never overwrites a later one.
 *
 * Limitation of both: a source recovers the receipt of an effect whose reply it lost only under the route's
 * current active revision. Pausing or revising a route while the source still has imports in flight leaves
 * such a reply unrecoverable until the route is active again at that revision; nothing committed is lost,
 * and restoring the route restores recovery. Change a route only after the source's outstanding work has settled.
 */
export const ConfigureCustomerSourceRoutePayloadSchema = Schema.Union([
  Schema.TaggedStruct('CONFIGURE', {
    expectedGeneration: Schema.OptionFromNullOr(CustomerSourceRouteGenerationSchema),
    reason: CustomerSourceRouteReasonSchema,
    route: CustomerSourceRouteSchema,
  }),
  Schema.TaggedStruct('PAUSE', {
    expectedGeneration: CustomerSourceRouteGenerationSchema,
    reason: CustomerSourceRouteReasonSchema,
    routeId: CustomerSourceRouteIdSchema,
    routeKind: CustomerSourceRouteKindSchema,
  }),
]);
export type ConfigureCustomerSourceRoutePayload = typeof ConfigureCustomerSourceRoutePayloadSchema.Type;

/**
 * A refusal names only the stored generation (none when no route is stored): the comparison never depends on a
 * stored route still satisfying today's route contract, so even such a route can be repaired or paused.
 * `PAUSED` names the generation that leaves the route inactive, the expected one when it already was.
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
  Schema.TaggedStruct('PAUSED', { generation: CustomerSourceRouteGenerationSchema }),
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
    'PAUSED',
    'EXPECTATION_MISMATCH',
    'PRINCIPAL_INELIGIBLE',
    'SOURCE_IDENTITY_IMMUTABLE',
  ]),
  previousGeneration: Schema.optionalKey(CustomerSourceRouteGenerationSchema),
  reason: CustomerSourceRouteReasonSchema,
  routeId: CustomerSourceRouteIdSchema,
  routeKind: CustomerSourceRouteKindSchema,
});

/**
 * A route exactly as its owner stores it. A route stored before the configuration Action existed may lack a fact
 * today's contract requires (a Group mapping revision, part of a Membership completeness contract); it is shown
 * with that fact absent (null), never with an invented one.
 */
const StoredRouteRefSchema = Schema.Struct({ id: Schema.String, revision: Schema.String });
const StoredFactSchema = Schema.OptionFromNullOr(Schema.String);
export const StoredCustomerSourceRouteSchema = Schema.Union([
  Schema.TaggedStruct('PROFILE', {
    active: Schema.Boolean,
    issuer: Schema.String,
    mappingRevision: Schema.String,
    namespace: Schema.String,
    principalId: PrincipalIdSchema,
    recordType: Schema.String,
    route: StoredRouteRefSchema,
    sourceReaderPrincipalIds: Schema.Array(PrincipalIdSchema),
  }),
  Schema.TaggedStruct('GROUP_DEFINITION', {
    active: Schema.Boolean,
    issuer: Schema.String,
    mappingRevision: StoredFactSchema,
    namespace: Schema.String,
    principalId: PrincipalIdSchema,
    route: StoredRouteRefSchema,
    sourceReaderPrincipalIds: Schema.Array(PrincipalIdSchema),
  }),
  Schema.TaggedStruct('MEMBERSHIP', {
    active: Schema.Boolean,
    allowComplete: Schema.Boolean,
    completenessContract: Schema.OptionFromNullOr(
      Schema.Struct({ coverage: StoredFactSchema, ref: StoredFactSchema, revision: StoredFactSchema }),
    ),
    issuer: Schema.String,
    principalId: PrincipalIdSchema,
    route: StoredRouteRefSchema,
    sourceNamespace: Schema.String,
  }),
  Schema.TaggedStruct('SAVED_ADDRESS', {
    active: Schema.Boolean,
    issuer: Schema.String,
    mappingRevision: Schema.String,
    namespace: Schema.String,
    principalId: PrincipalIdSchema,
    recordType: Schema.String,
    route: StoredRouteRefSchema,
  }),
]);

/** One decision in a route's append-only history, without the route documents it compared. */
export const CustomerSourceRouteHistoryEntrySchema = Schema.Struct({
  actingPrincipalId: PrincipalIdSchema,
  actionInvocationId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ActionInvocationId')),
  generation: CustomerSourceRouteGenerationSchema,
  reason: Schema.String,
  recordedAt: Schema.DateTimeUtcFromString,
});

export class CustomerSourceRouteUnavailable extends Schema.TaggedError<CustomerSourceRouteUnavailable>()(
  'CustomerSourceRouteUnavailable',
  {
    code: Schema.Literal('PERSISTENCE_UNAVAILABLE'),
    reason: Schema.String,
  },
) {}
