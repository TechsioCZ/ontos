import { OntosModuleIdSchema } from '@app/core-runtime';
import { Schema } from 'effect';

import { MarketRefSchema } from '../resources/market.ts';

const nonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());
const positiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const referenceCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const sha256Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const utcInstant = Schema.toEncoded(Schema.DateTimeUtcFromString);

const MarketRetirementReferenceEvidenceSchema = Schema.Struct({
  count: referenceCount,
  evidenceReference: nonEmptyText,
});

export const MarketRetirementProviderAssessmentSchema = Schema.Struct({
  completenessEvidenceReference: nonEmptyText,
  currentnessEvidenceReference: nonEmptyText,
  effectiveAt: utcInstant,
  liveBlockingReferences: MarketRetirementReferenceEvidenceSchema,
  nextBoundaryAt: Schema.optionalKey(utcInstant),
  observedAt: utcInstant,
  ownerModuleKey: OntosModuleIdSchema,
  ownerRevision: nonEmptyText,
  retainedHistoryEvidence: MarketRetirementReferenceEvidenceSchema,
  versionToken: nonEmptyText,
});
export type MarketRetirementProviderAssessment = typeof MarketRetirementProviderAssessmentSchema.Type;

const MarketRetirementReservationSchema = Schema.Struct({
  token: nonEmptyText,
  version: positiveRevision,
});

export const MarketRetirementImpactAssessmentSchema = Schema.Struct({
  assessedMarketRef: MarketRefSchema,
  assessedMarketRevision: positiveRevision,
  assessmentDigest: sha256Digest,
  effectiveAt: utcInstant,
  providers: Schema.Array(MarketRetirementProviderAssessmentSchema).check(Schema.isMaxLength(32)),
  requiredProviderModuleKeys: Schema.Array(OntosModuleIdSchema).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  reservation: Schema.optionalKey(MarketRetirementReservationSchema),
});
export type MarketRetirementImpactAssessment = typeof MarketRetirementImpactAssessmentSchema.Type;
export type ReservedMarketRetirementImpactAssessment = MarketRetirementImpactAssessment & {
  readonly reservation: typeof MarketRetirementReservationSchema.Type;
};
