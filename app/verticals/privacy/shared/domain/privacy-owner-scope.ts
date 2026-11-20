import { Schema } from 'effect';

const OwnerLookupRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
const OwnerResourceKeySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('PrivacyOwnerLookupResourceKey'),
);
const OwnerResourceLookupFields = {
  lookupRef: OwnerLookupRefSchema,
  moduleId: OwnerResourceKeySchema,
  resourceId: OwnerResourceKeySchema,
  resourceType: OwnerResourceKeySchema,
} as const;

/**
 * The typed, already confirmed lookups Privacy hands an owner: a subject resource, a contact resource, or a staff actor. The
 * owner finds records only by these exact references and performs no Party Matching. The owner's own contract validates them
 * again, so this public shape never decides what an owner accepts.
 */
export const OwnerInventoryLookupSchema = Schema.Union([
  Schema.TaggedStruct('SUBJECT_REFERENCE', OwnerResourceLookupFields),
  Schema.TaggedStruct('CONTACT_REFERENCE', OwnerResourceLookupFields),
  Schema.TaggedStruct('ACTOR_PRINCIPAL', {
    lookupRef: OwnerLookupRefSchema,
    principalId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyOwnerLookupPrincipalId')),
  }),
]);

const OwnerScopeRef = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const hasUniqueRefs = (refs: readonly string[]): boolean => new Set(refs).size === refs.length;

/**
 * The exact owner scope an owner-contract owner (#595-#605) needs to evaluate a Privacy Measure, carried by the handoff next
 * to the fields it already has: the owner capability, tenant, subject and DSR controller obligation are the handoff's own.
 * Optional and additive: a handoff for an owner that does not evaluate against an owner scope never carries one, and the
 * values are only ever what Privacy's own owner-inventory request defines for the same owner scope.
 */
export const PrivacyMeasureOwnerScopeSchema = Schema.Struct({
  controllerRef: OwnerScopeRef,
  requestedScopePartRefs: Schema.Array(OwnerScopeRef).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  requestedScopeRef: OwnerScopeRef,
  trustedLookups: Schema.Array(OwnerInventoryLookupSchema).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
}).check(
  Schema.makeFilter((scope) =>
    hasUniqueRefs(scope.requestedScopePartRefs) && hasUniqueRefs(scope.trustedLookups.map(({ lookupRef }) => lookupRef))
      ? undefined
      : 'Owner scope parts and trusted lookup references must be unique',
  ),
);
