import { DateTime, Schema } from 'effect';

const opaqueOwnerReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

const ExactPredicateScopeSchema = Schema.Struct({
  kind: Schema.Literal('EXACT_PREDICATE'),
  predicateRef: opaqueOwnerReference,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const SafelyBroaderScopeSchema = Schema.Struct({
  declaredScopeRef: opaqueOwnerReference,
  kind: Schema.Literal('SAFELY_BROADER_SCOPE'),
  predicateRef: opaqueOwnerReference,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

/**
 * Identifies the exact decision predicate covered by an owner's proof. A safely broader
 * proof also names the owner-declared scope whose invalidation contract covers every
 * material change to that predicate.
 */
export const OwnerVerifiableSetCompletenessScopeSchema = Schema.Union([
  ExactPredicateScopeSchema,
  SafelyBroaderScopeSchema,
]);
export type OwnerVerifiableSetCompletenessScope = typeof OwnerVerifiableSetCompletenessScopeSchema.Type;

/**
 * Cross-owner evidence envelope only. The issuing owner defines the referenced predicate,
 * broader scope, revision identity, invalidation triggers, and verification behavior.
 */
export const OwnerVerifiableSetCompletenessEvidenceSchema = Schema.Struct({
  nextApplicabilityBoundary: Schema.optionalKey(Schema.DateTimeUtcFromString),
  observedAt: Schema.DateTimeUtcFromString,
  ownerRevision: opaqueOwnerReference,
  scope: OwnerVerifiableSetCompletenessScopeSchema,
})
  .check(
    Schema.makeFilter((evidence) =>
      evidence.nextApplicabilityBoundary === undefined ||
      DateTime.toEpochMillis(evidence.nextApplicabilityBoundary) > DateTime.toEpochMillis(evidence.observedAt)
        ? undefined
        : {
            issue: 'nextApplicabilityBoundary must be later than observedAt',
            path: ['nextApplicabilityBoundary'],
          },
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: 'error' } });
export type OwnerVerifiableSetCompletenessEvidence = typeof OwnerVerifiableSetCompletenessEvidenceSchema.Type;
export type OwnerVerifiableSetCompletenessEvidenceEncoded = typeof OwnerVerifiableSetCompletenessEvidenceSchema.Encoded;
