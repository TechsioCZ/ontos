import { DateTime, Match, Schema } from 'effect';
import {
  AssortmentCatalogSelectorSchema,
  AssortmentCommercialScopeSchema,
  AssortmentDecisionPurposeSchema,
  AssortmentDecisionSubjectSchema,
  AssortmentPurchasingSubjectSchema,
  AssortmentEffectSchema,
  AssortmentEvidenceReferenceSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentSetCompletenessEvidenceSchema,
} from './decision-contracts.ts';
import { AssortmentCollectionRevisionRefSchema } from '../actions/boundary-administration.ts';
import { AssortmentBindingAudienceSchema } from '../actions/policy-administration.ts';

const NonEmptyTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const DigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const InstantSchema = Schema.DateTimeUtcFromString;
const DatasetIdSchema = NonEmptyTextSchema.pipe(Schema.brand('AssortmentMigrationDatasetId'));
const SourceSystemIdSchema = NonEmptyTextSchema.pipe(Schema.brand('AssortmentMigrationSourceSystemId'));
const MigrationTargetKindSchema = Schema.Literals(['BOUNDARY', 'RULE_BINDING']);

export const AssortmentMigrationJourneySchema = Schema.Literals(['VISIBILITY', 'PURCHASE']);

export const AssortmentMigrationDispositionSchema = Schema.Literals(['RETAIN', 'TRANSFORM', 'RETIRE', 'UNRESOLVED']);

export const AssortmentMigrationCorrelationStatusSchema = Schema.Literals(['MATCHED', 'AMBIGUOUS', 'UNRESOLVED']);

export const AssortmentMigrationCorrelationTargetSchema = Schema.Literals([
  'CATALOG',
  'CATEGORY',
  'CHANNEL',
  'COUNTERPARTY',
  'GROUP',
  'MARKET',
  'PROFILE',
  'SELLING_LEGAL_ENTITY',
  'STOREFRONT',
]);

export const AssortmentMigrationGapSchema = Schema.Literals([
  'ADMISSION_SET',
  'CANONICAL_IDENTITY',
  'COMMERCIAL_SCOPE',
  'COMPLETENESS',
  'EFFECT',
  'LIFECYCLE',
  'OWNER_EVIDENCE',
  'PURPOSE',
  'SOURCE_OWNER',
  'SOURCE_PROVENANCE',
  'SUBJECT',
]);
export type AssortmentMigrationGap = typeof AssortmentMigrationGapSchema.Type;

const MigrationSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('SHARED') }),
  AssortmentDecisionSubjectSchema,
]);

const MigrationLifecycleSchema = Schema.Struct({
  effectiveFrom: InstantSchema,
  effectiveTo: Schema.optionalKey(InstantSchema),
}).check(
  Schema.makeFilter((lifecycle) => {
    if (lifecycle.effectiveTo === undefined) {
      return true;
    }
    return DateTime.isLessThan(lifecycle.effectiveFrom, lifecycle.effectiveTo)
      ? true
      : 'migration lifecycle must end after it starts';
  }),
);

const MigrationAdmissionSetSchema = Schema.Struct({
  collectionRevisionRef: AssortmentCollectionRevisionRefSchema,
  contentHash: DigestSchema,
  entries: Schema.optionalKey(Schema.Array(AssortmentCatalogSelectorSchema)),
  memberCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  setKind: Schema.Literals(['EMPTY', 'ENTRIES']),
});

const CompleteAdmissionSetSchema = Schema.Struct({
  ...MigrationAdmissionSetSchema.fields,
  entries: Schema.Array(AssortmentCatalogSelectorSchema),
}).check(
  Schema.makeFilter((admissionSet) =>
    admissionSet.memberCount === admissionSet.entries.length &&
    (admissionSet.setKind === 'EMPTY') === (admissionSet.entries.length === 0)
      ? undefined
      : 'complete migration Admission Set entries must match its count and kind',
  ),
);

const CompleteOrdinaryMeaningSchema = Schema.Struct({
  audience: AssortmentBindingAudienceSchema,
  commercialScope: AssortmentCommercialScopeSchema,
  completeness: AssortmentSetCompletenessEvidenceSchema,
  effect: AssortmentEffectSchema,
  lifecycle: MigrationLifecycleSchema,
  purpose: AssortmentDecisionPurposeSchema,
  selector: AssortmentCatalogSelectorSchema,
  targetKind: Schema.Literal('RULE_BINDING'),
});

const CompleteBoundaryMeaningSchema = Schema.Struct({
  admissionSet: CompleteAdmissionSetSchema,
  commercialScope: AssortmentCommercialScopeSchema,
  completeness: AssortmentSetCompletenessEvidenceSchema,
  lifecycle: MigrationLifecycleSchema,
  purpose: AssortmentDecisionPurposeSchema,
  subject: Schema.Struct({ kind: Schema.Literal('IDENTIFIED'), subject: AssortmentPurchasingSubjectSchema }),
  targetKind: Schema.Literal('BOUNDARY'),
});

/** Exact canonical meaning, intentionally partial so unresolved source facts can be recorded. */
export const AssortmentMigrationCanonicalMeaningSchema = Schema.Struct({
  admissionSet: Schema.optionalKey(MigrationAdmissionSetSchema),
  audience: Schema.optionalKey(AssortmentBindingAudienceSchema),
  commercialScope: Schema.optionalKey(AssortmentCommercialScopeSchema),
  completeness: Schema.optionalKey(AssortmentSetCompletenessEvidenceSchema),
  effect: Schema.optionalKey(AssortmentEffectSchema),
  lifecycle: Schema.optionalKey(MigrationLifecycleSchema),
  purpose: Schema.optionalKey(AssortmentDecisionPurposeSchema),
  selector: Schema.optionalKey(AssortmentCatalogSelectorSchema),
  subject: Schema.optionalKey(MigrationSubjectSchema),
  targetKind: Schema.optionalKey(MigrationTargetKindSchema),
});
export type AssortmentMigrationCanonicalMeaning = typeof AssortmentMigrationCanonicalMeaningSchema.Type;

/** Source identifiers are represented only by opaque digests; raw IDs and payloads are excluded. */
export const AssortmentMigrationSourceProvenanceSchema = Schema.Struct({
  datasetId: DatasetIdSchema,
  observedAt: InstantSchema,
  sourceLocatorDigest: Schema.optionalKey(DigestSchema),
  sourceOwner: NonEmptyTextSchema,
  sourceRecordDigest: DigestSchema,
  sourceRevision: NonEmptyTextSchema,
  sourceSystemId: SourceSystemIdSchema,
});

export const AssortmentMigrationCorrelationSchema = Schema.Struct({
  canonicalRef: Schema.optionalKey(AssortmentOwnerResourceRefSchema),
  evidenceRef: Schema.optionalKey(AssortmentEvidenceReferenceSchema),
  method: NonEmptyTextSchema,
  sourceRecordDigest: DigestSchema,
  status: AssortmentMigrationCorrelationStatusSchema,
  target: AssortmentMigrationCorrelationTargetSchema,
}).check(
  Schema.makeFilter((correlation) => {
    if (
      correlation.status === 'MATCHED' &&
      (correlation.canonicalRef === undefined || correlation.evidenceRef === undefined)
    ) {
      return 'matched correlations require a canonical reference and owner evidence';
    }
    if (correlation.status !== 'MATCHED' && correlation.canonicalRef !== undefined) {
      return 'ambiguous or unresolved correlations cannot claim a canonical reference';
    }
    return true;
  }),
);

export const AssortmentMigrationClassificationSchema = Schema.Struct({
  disposition: AssortmentMigrationDispositionSchema,
  evidenceRefs: Schema.Array(AssortmentEvidenceReferenceSchema),
  proposedDisposition: Schema.optionalKey(AssortmentMigrationDispositionSchema),
  reason: NonEmptyTextSchema,
});

export const AssortmentMigrationEvidenceRecordSchema = Schema.Struct({
  affectedJourneys: Schema.Array(AssortmentMigrationJourneySchema).check(Schema.isMinLength(1)),
  canonicalMeaning: Schema.optionalKey(AssortmentMigrationCanonicalMeaningSchema),
  classification: AssortmentMigrationClassificationSchema,
  correlations: Schema.Array(AssortmentMigrationCorrelationSchema),
  factFamily: NonEmptyTextSchema,
  gaps: Schema.Array(AssortmentMigrationGapSchema),
  ownerEvidenceRefs: Schema.Array(AssortmentEvidenceReferenceSchema),
  source: AssortmentMigrationSourceProvenanceSchema,
}).check(
  Schema.makeFilter((record) =>
    record.correlations.every((correlation) => correlation.sourceRecordDigest === record.source.sourceRecordDigest)
      ? true
      : 'correlation source digests must identify the containing source record',
  ),
);
export type AssortmentMigrationEvidenceRecord = typeof AssortmentMigrationEvidenceRecordSchema.Type;

const selectorSupportsPurpose = (
  purpose: AssortmentMigrationCanonicalMeaning['purpose'],
  selector: typeof AssortmentCatalogSelectorSchema.Type,
): boolean => purpose !== 'VISIBILITY' || (selector.kind !== 'VARIANT' && selector.kind !== 'PACKAGE_OPTION');

const hasCompleteCanonicalMeaning = (record: AssortmentMigrationEvidenceRecord): boolean => {
  const meaning = record.canonicalMeaning;
  if (meaning?.completeness?.state !== 'COMPLETE') {
    return false;
  }
  if (meaning.targetKind === 'BOUNDARY') {
    return (
      Schema.is(CompleteBoundaryMeaningSchema)(meaning) &&
      meaning.audience === undefined &&
      meaning.effect === undefined &&
      meaning.selector === undefined &&
      meaning.admissionSet !== undefined &&
      meaning.admissionSet.entries !== undefined &&
      meaning.admissionSet.entries.every((entry) => selectorSupportsPurpose(meaning.purpose, entry))
    );
  }
  return (
    Schema.is(CompleteOrdinaryMeaningSchema)(meaning) &&
    meaning.subject === undefined &&
    meaning.admissionSet === undefined &&
    meaning.selector !== undefined &&
    selectorSupportsPurpose(meaning.purpose, meaning.selector)
  );
};

interface CorrelationRequirement {
  canonicalRef: typeof AssortmentOwnerResourceRefSchema.Type;
  target: typeof AssortmentMigrationCorrelationTargetSchema.Type;
}

const selectorCorrelations = (selector: typeof AssortmentCatalogSelectorSchema.Type): CorrelationRequirement[] =>
  Match.value(selector).pipe(
    Match.discriminatorsExhaustive('kind')({
      ALL: (): CorrelationRequirement[] => [],
      CATEGORY: (value): CorrelationRequirement[] => [{ canonicalRef: value.categoryRef, target: 'CATEGORY' }],
      PACKAGE_OPTION: (value): CorrelationRequirement[] => [
        { canonicalRef: value.packageOptionRef, target: 'CATALOG' },
      ],
      PRODUCT: (value): CorrelationRequirement[] => [{ canonicalRef: value.productRef, target: 'CATALOG' }],
      VARIANT: (value): CorrelationRequirement[] => [{ canonicalRef: value.variantRef, target: 'CATALOG' }],
    }),
  );

const subjectCorrelation = (subject: typeof AssortmentPurchasingSubjectSchema.Type): CorrelationRequirement =>
  subject.kind === 'COUNTERPARTY'
    ? { canonicalRef: subject.counterpartyRef, target: 'COUNTERPARTY' }
    : { canonicalRef: subject.profileRef, target: 'PROFILE' };

const requiredCorrelations = (meaning: AssortmentMigrationCanonicalMeaning): CorrelationRequirement[] => {
  const requirements: CorrelationRequirement[] = [];
  if (meaning.commercialScope !== undefined) {
    requirements.push(
      { canonicalRef: meaning.commercialScope.channelRef, target: 'CHANNEL' },
      { canonicalRef: meaning.commercialScope.sellingLegalEntityRef, target: 'SELLING_LEGAL_ENTITY' },
    );
    if (meaning.commercialScope.commerceMarketRef !== undefined) {
      requirements.push({ canonicalRef: meaning.commercialScope.commerceMarketRef, target: 'MARKET' });
    }
    if (meaning.commercialScope.storefrontRef !== undefined) {
      requirements.push({ canonicalRef: meaning.commercialScope.storefrontRef, target: 'STOREFRONT' });
    }
  }
  if (meaning.targetKind === 'RULE_BINDING') {
    if (meaning.selector !== undefined) {
      requirements.push(...selectorCorrelations(meaning.selector));
    }
    if (meaning.audience?.kind === 'COMMERCE_CUSTOMER_GROUP') {
      requirements.push({ canonicalRef: meaning.audience.groupRef, target: 'GROUP' });
    } else if (meaning.audience?.kind === 'SUBJECT') {
      requirements.push(subjectCorrelation(meaning.audience.subject));
    }
  } else if (meaning.targetKind === 'BOUNDARY') {
    if (meaning.subject?.kind === 'IDENTIFIED') {
      requirements.push(subjectCorrelation(meaning.subject.subject));
    }
    for (const entry of meaning.admissionSet?.entries ?? []) {
      requirements.push(...selectorCorrelations(entry));
    }
  }
  return requirements;
};

const sameReference = (
  left: typeof AssortmentOwnerResourceRefSchema.Type,
  right: typeof AssortmentOwnerResourceRefSchema.Type,
): boolean =>
  left.tenantId === right.tenantId &&
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId;

const hasOwnerMatchedIdentity = (record: AssortmentMigrationEvidenceRecord): boolean =>
  record.canonicalMeaning !== undefined &&
  record.correlations.every((correlation) => correlation.status === 'MATCHED') &&
  requiredCorrelations(record.canonicalMeaning).every((required) =>
    record.correlations.some(
      (correlation) =>
        correlation.target === required.target &&
        correlation.canonicalRef !== undefined &&
        correlation.evidenceRef !== undefined &&
        sameReference(correlation.canonicalRef, required.canonicalRef),
    ),
  );

const addBoundaryMeaningGaps = (
  gaps: Set<AssortmentMigrationGap>,
  meaning: AssortmentMigrationCanonicalMeaning,
): void => {
  if (meaning.subject?.kind !== 'IDENTIFIED' || meaning.audience !== undefined) {
    gaps.add('SUBJECT');
  }
  if (meaning.admissionSet === undefined || !Schema.is(CompleteAdmissionSetSchema)(meaning.admissionSet)) {
    gaps.add('ADMISSION_SET');
  }
  if (meaning.effect !== undefined) {
    gaps.add('EFFECT');
  }
  if (
    meaning.selector !== undefined ||
    meaning.admissionSet?.entries?.some((entry) => !selectorSupportsPurpose(meaning.purpose, entry)) === true
  ) {
    gaps.add('PURPOSE');
  }
};

const addOrdinaryMeaningGaps = (
  gaps: Set<AssortmentMigrationGap>,
  meaning: AssortmentMigrationCanonicalMeaning | undefined,
): void => {
  if (meaning?.audience === undefined || meaning.subject !== undefined) {
    gaps.add('SUBJECT');
  }
  if (meaning?.effect === undefined) {
    gaps.add('EFFECT');
  }
  if (meaning?.selector === undefined || meaning.targetKind !== 'RULE_BINDING') {
    gaps.add('CANONICAL_IDENTITY');
  } else if (!selectorSupportsPurpose(meaning.purpose, meaning.selector)) {
    gaps.add('PURPOSE');
  }
  if (meaning?.admissionSet !== undefined) {
    gaps.add('ADMISSION_SET');
  }
};

const addMeaningGaps = (
  gaps: Set<AssortmentMigrationGap>,
  meaning: AssortmentMigrationCanonicalMeaning | undefined,
): void => {
  if (meaning?.targetKind === 'BOUNDARY') {
    addBoundaryMeaningGaps(gaps, meaning);
  } else {
    addOrdinaryMeaningGaps(gaps, meaning);
  }
  if (meaning?.purpose === undefined) {
    gaps.add('PURPOSE');
  }
  if (meaning?.commercialScope === undefined) {
    gaps.add('COMMERCIAL_SCOPE');
  }
  if (meaning?.lifecycle === undefined) {
    gaps.add('LIFECYCLE');
  }
  if (meaning?.completeness?.state !== 'COMPLETE') {
    gaps.add('COMPLETENESS');
  }
};

const missingMigrationGaps = (record: AssortmentMigrationEvidenceRecord): readonly AssortmentMigrationGap[] => {
  const retirement = record.classification.disposition === 'RETIRE';
  const gaps = new Set<AssortmentMigrationGap>(
    retirement
      ? record.gaps.filter((gap) => gap === 'SOURCE_OWNER' || gap === 'SOURCE_PROVENANCE' || gap === 'OWNER_EVIDENCE')
      : record.gaps,
  );
  if (record.ownerEvidenceRefs.length === 0 || record.classification.evidenceRefs.length === 0) {
    gaps.add('OWNER_EVIDENCE');
  }
  if (!retirement) {
    if (!hasOwnerMatchedIdentity(record)) {
      gaps.add('CANONICAL_IDENTITY');
    }
    addMeaningGaps(gaps, record.canonicalMeaning);
    if (!hasCompleteCanonicalMeaning(record) && gaps.size === 0) {
      gaps.add('CANONICAL_IDENTITY');
    }
  }
  return [...gaps].toSorted((left, right) => left.localeCompare(right, 'en'));
};

/**
 * Applies the migration safety default: an incomplete or unproven record can
 * only remain UNRESOLVED, regardless of a caller-supplied proposed verdict.
 */
export const normalizeAssortmentMigrationEvidenceRecord = (
  record: AssortmentMigrationEvidenceRecord,
): AssortmentMigrationEvidenceRecord => {
  const gaps = missingMigrationGaps(record);
  const disposition = gaps.length === 0 ? record.classification.disposition : 'UNRESOLVED';
  return {
    ...record,
    classification: { ...record.classification, disposition },
    gaps,
  };
};
