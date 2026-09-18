/* eslint-disable effect-native/no-string-timestamp-schema, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Schema } from 'effect';

const Text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const Reference = Text;
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u));

const OwnerCoverageResultSchema = Schema.Literals(['COMPLETE', 'NO_DATA', 'PARTIAL', 'UNAVAILABLE', 'INDETERMINATE']);

const OwnerContributionCompletionSchema = Schema.Literals(['OPEN', 'COMPLETE', 'INCOMPLETE']);

const OwnerContributionBatchSchema = Schema.Struct({
  batchId: Reference,
  capturedAt: Timestamp,
  consistency: Schema.Literals(['CONSISTENT', 'INDETERMINATE']),
  coveredScopeRefs: Schema.Array(Reference).check(Schema.isMaxLength(256)),
  includedResourceRefs: Schema.Array(Reference).check(Schema.isMaxLength(256)),
  missingScopeRefs: Schema.Array(Reference).check(Schema.isMaxLength(256)),
  observedAt: Timestamp,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

const OwnerContributionExclusionSchema = Schema.Struct({
  reason: Text,
  scopeRef: Reference,
});

export const OwnerContributionSchema = Schema.Struct({
  batches: Schema.Array(OwnerContributionBatchSchema).check(Schema.isMaxLength(256)),
  captureTime: Timestamp,
  completion: OwnerContributionCompletionSchema,
  contributionId: Reference,
  controllerObligationRef: Reference,
  coverageResult: OwnerCoverageResultSchema,
  decisionScope: Reference,
  exclusions: Schema.Array(OwnerContributionExclusionSchema).check(Schema.isMaxLength(256)),
  includedContentRefs: Schema.Array(Reference).check(Schema.isMaxLength(256)),
  observationTime: Timestamp,
  ownerScope: Schema.Array(Reference).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  owningCapability: Reference,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  right: Schema.Literals(['ACCESS', 'PORTABILITY', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'OBJECTION']),
  subjectRef: Reference,
});
export type OwnerContribution = typeof OwnerContributionSchema.Type;

export interface OwnerContributionAssembly {
  readonly atomicSnapshot: false;
  readonly complete: boolean;
  readonly contributions: readonly OwnerContribution[];
  readonly observationTimes: ReadonlyMap<string, string>;
}

/**
 * Assemble owner-owned references and facts without copying owner payloads or
 * pretending that different capture times form a distributed snapshot.
 */
export const assembleOwnerContributions = (
  requiredOwningCapabilities: readonly string[],
  contributions: readonly OwnerContribution[],
): OwnerContributionAssembly => {
  const latestByOwner = new Map<string, OwnerContribution>();
  for (const contribution of contributions) {
    const current = latestByOwner.get(contribution.owningCapability);
    if (current === undefined || contribution.revision > current.revision) {
      latestByOwner.set(contribution.owningCapability, contribution);
    }
  }
  const observationTimes = new Map(
    [...latestByOwner].map(([owner, contribution]) => [owner, contribution.observationTime]),
  );
  const complete = requiredOwningCapabilities.every((owner) => {
    const contribution = latestByOwner.get(owner);
    return (
      contribution?.completion === 'COMPLETE' &&
      (contribution.coverageResult === 'NO_DATA' ||
        (contribution.coverageResult === 'COMPLETE' && contribution.batches.length > 0))
    );
  });
  return { atomicSnapshot: false, complete, contributions: [...latestByOwner.values()], observationTimes };
};

const ProtectionOutcomeSchema = Schema.Literals(['INCLUDE', 'EXCLUDE', 'REDACT', 'FAILED']);

const ProtectedContentDecisionSchema = Schema.Struct({
  affectedScope: Reference,
  contentRef: Reference,
  outcome: ProtectionOutcomeSchema,
  reason: Text,
});
export type ProtectedContentDecision = typeof ProtectedContentDecisionSchema.Type;

export interface ProtectedContentInput {
  readonly affectedScope: string;
  readonly containsOtherDataSubjects: boolean;
  readonly contentRef: string;
  readonly eligibleForRight: boolean;
  readonly protectionSucceeded: boolean;
  readonly separable: boolean;
}

/**
 * Applies right-specific eligibility and the narrowest third-party exclusion.
 * This returns references and decisions only; it never stores or rewrites the
 * owner's canonical content.
 */
export const decideProtectedContent = (input: ProtectedContentInput): ProtectedContentDecision => {
  if (!input.protectionSucceeded) {
    return {
      affectedScope: input.affectedScope,
      contentRef: input.contentRef,
      outcome: 'FAILED',
      reason: 'Technical protection or redaction failed',
    };
  }
  if (!input.eligibleForRight) {
    return {
      affectedScope: input.affectedScope,
      contentRef: input.contentRef,
      outcome: 'EXCLUDE',
      reason: 'Content is outside the approved right-specific eligibility scope',
    };
  }
  if (!input.containsOtherDataSubjects) {
    return {
      affectedScope: input.affectedScope,
      contentRef: input.contentRef,
      outcome: 'INCLUDE',
      reason: 'Content is eligible and contains no protected third-party scope',
    };
  }
  if (input.separable) {
    return {
      affectedScope: input.affectedScope,
      contentRef: input.contentRef,
      outcome: 'REDACT',
      reason: 'Only the separable third-party scope is protected',
    };
  }
  return {
    affectedScope: input.affectedScope,
    contentRef: input.contentRef,
    outcome: 'EXCLUDE',
    reason: 'Protected third-party content is not reasonably separable',
  };
};
