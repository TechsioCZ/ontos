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
 * One current blocker of a content change that Privacy itself holds for exact content: a Legal Hold or a retention obligation.
 * Privacy is the only authority for them. The owner keeps no hold source of its own, so a measure names them here or says
 * nothing about them (and then the owner cannot treat the absence as "no blocker").
 */
export const OwnerMeasureBlockerSchema = Schema.Struct({
  blockerRef: OwnerScopeRef,
  contentRefs: Schema.Array(OwnerScopeRef).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  kind: Schema.Literals(['LEGAL_HOLD', 'RETENTION_OBLIGATION']),
});

/**
 * Privacy's explicit statement that blocker applicability for this measure WAS assessed, by whom (`assessedByRef`: the Privacy
 * owner or rule reference that assessed it) and which blockers it found. An empty list is "no blocker assessed by
 * `assessedByRef`"; an absent assessment is "not assessed" and is never read as "none".
 */
export const OwnerBlockerAssessmentSchema = Schema.Struct({
  assessedByRef: OwnerScopeRef,
  blockers: Schema.Array(OwnerMeasureBlockerSchema).check(Schema.isMaxLength(64)),
}).check(
  Schema.makeFilter((assessment) =>
    hasUniqueRefs(assessment.blockers.map(({ blockerRef }) => blockerRef))
      ? undefined
      : 'Blocker references must be unique',
  ),
);
export type OwnerBlockerAssessment = typeof OwnerBlockerAssessmentSchema.Type;

/**
 * The exact owner scope an owner-contract owner (#595-#605) needs to evaluate a Privacy Measure, carried by the handoff next
 * to the fields it already has: the owner capability, tenant, subject and DSR controller obligation are the handoff's own.
 * Optional and additive: a handoff for an owner that does not evaluate against an owner scope never carries one, and the
 * values are only ever what Privacy's own owner-inventory request defines for the same owner scope.
 */
export const PrivacyMeasureOwnerScopeSchema = Schema.Struct({
  blockerAssessment: Schema.optionalKey(OwnerBlockerAssessmentSchema),
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

export type PrivacyMeasureOwnerScope = typeof PrivacyMeasureOwnerScopeSchema.Type;

/**
 * The owner scope with every reference set in its canonical order (their order carries no meaning), so the same scope encodes
 * and fingerprints identically wherever it is computed: the coordinator that dispatches it and the owner that attests it.
 */
export const normalizeOwnerScope = (ownerScope: PrivacyMeasureOwnerScope): PrivacyMeasureOwnerScope => {
  const { blockerAssessment, ...rest } = ownerScope;
  const normalized: PrivacyMeasureOwnerScope = {
    ...rest,
    requestedScopePartRefs: ownerScope.requestedScopePartRefs.toSorted(),
    trustedLookups: ownerScope.trustedLookups.toSorted((left, right) => left.lookupRef.localeCompare(right.lookupRef)),
  };
  return blockerAssessment === undefined
    ? normalized
    : {
        ...normalized,
        blockerAssessment: {
          ...blockerAssessment,
          blockers: blockerAssessment.blockers
            .map((blocker) => ({ ...blocker, contentRefs: blocker.contentRefs.toSorted() }))
            .toSorted((left, right) => left.blockerRef.localeCompare(right.blockerRef)),
        },
      };
};
