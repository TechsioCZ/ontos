/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Schema } from 'effect';

import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Dimension = Schema.Literals([
  'CONTROLLER',
  'PROCESSING_PURPOSE',
  'PURPOSE_MEANING',
  'PURPOSE_VERSION',
  'PERSONAL_DATA_CATEGORY',
  'RECIPIENT',
  'APPLICABILITY',
  'PROCESSING_SCOPE',
  'CONSENT_REQUIREMENT',
]);
export type PrivacyMaterialChangeDimension = typeof Dimension.Type;

/** Only business meaning and material scope participate in materiality. Wording is evidence, not a heuristic. */
export const PrivacyChangeSnapshotSchema = Schema.Struct({
  applicabilityKey: Ref,
  consentRequired: Schema.Boolean,
  consentScopeKey: Schema.NullOr(Ref),
  controllerRef: Ref,
  dataCategoryRefs: Schema.Array(Ref),
  meaning: Ref,
  processingScopeRef: Ref,
  purposeRef: Ref,
  purposeVersionRef: Ref,
  recipientRefs: Schema.Array(Ref),
});
export type PrivacyChangeSnapshot = typeof PrivacyChangeSnapshotSchema.Type;

export const MaterialPrivacyChangeInputSchema = Schema.Struct({
  affectedPrivacySubjectRefs: Schema.Array(Ref),
  changedAt: PrivacyIsoTimestampSchema,
  changeRef: Ref,
  current: PrivacyChangeSnapshotSchema,
  previous: PrivacyChangeSnapshotSchema,
});
export type MaterialPrivacyChangeInput = typeof MaterialPrivacyChangeInputSchema.Type;

export const PrivacyMaterialitySchema = Schema.Literals(['EDITORIAL', 'MATERIAL']);
export type PrivacyMateriality = typeof PrivacyMaterialitySchema.Type;

export const PrivacyRenoticeOutcomeSchema = Schema.Literals([
  'NO_RENOTICE_REQUIRED',
  'RENOTICE_REQUIRED',
  'RENOTICE_AND_NEW_CONSENT_REQUIRED',
  'OUT_OF_SCOPE',
]);
export type PrivacyRenoticeOutcome = typeof PrivacyRenoticeOutcomeSchema.Type;

export const PrivacyMaterialChangeAssessmentSchema = Schema.Struct({
  affectedPrivacySubjectRefs: Schema.Array(Ref),
  applyBlockedUntilCurrentRequirements: Schema.Boolean,
  changedAt: PrivacyIsoTimestampSchema,
  changedDimensions: Schema.Array(Dimension),
  changeRef: Ref,
  current: PrivacyChangeSnapshotSchema,
  historicalConsentDecisionsPreserved: Schema.Literal(true),
  historicalNoticeProvisionPreserved: Schema.Literal(true),
  materiality: PrivacyMaterialitySchema,
  newConsentDecisionRequired: Schema.Boolean,
  outcome: PrivacyRenoticeOutcomeSchema,
  previous: PrivacyChangeSnapshotSchema,
});
export type PrivacyMaterialChangeAssessment = typeof PrivacyMaterialChangeAssessmentSchema.Type;

const sorted = (values: readonly string[]): string[] => [...new Set(values)].toSorted();
const same = (left: readonly string[], right: readonly string[]): boolean => {
  const sortedLeft = sorted(left);
  const sortedRight = sorted(right);
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
};

const renoticeOutcome = (
  material: boolean,
  hasAffectedSubjects: boolean,
  newConsentDecisionRequired: boolean,
): PrivacyRenoticeOutcome => {
  if (!material) {
    return 'NO_RENOTICE_REQUIRED';
  }
  if (!hasAffectedSubjects) {
    return 'OUT_OF_SCOPE';
  }
  return newConsentDecisionRequired ? 'RENOTICE_AND_NEW_CONSENT_REQUIRED' : 'RENOTICE_REQUIRED';
};

export const changedPrivacyMaterialDimensions = (
  previous: PrivacyChangeSnapshot,
  current: PrivacyChangeSnapshot,
): readonly PrivacyMaterialChangeDimension[] => {
  const changed: PrivacyMaterialChangeDimension[] = [];
  if (previous.controllerRef !== current.controllerRef) {
    changed.push('CONTROLLER');
  }
  if (previous.purposeRef !== current.purposeRef) {
    changed.push('PROCESSING_PURPOSE');
  }
  if (previous.meaning !== current.meaning) {
    changed.push('PURPOSE_MEANING');
  }
  if (previous.purposeVersionRef !== current.purposeVersionRef) {
    changed.push('PURPOSE_VERSION');
  }
  if (!same(previous.dataCategoryRefs, current.dataCategoryRefs)) {
    changed.push('PERSONAL_DATA_CATEGORY');
  }
  if (!same(previous.recipientRefs, current.recipientRefs)) {
    changed.push('RECIPIENT');
  }
  if (previous.applicabilityKey !== current.applicabilityKey) {
    changed.push('APPLICABILITY');
  }
  if (previous.processingScopeRef !== current.processingScopeRef) {
    changed.push('PROCESSING_SCOPE');
  }
  if (previous.consentRequired !== current.consentRequired) {
    changed.push('CONSENT_REQUIREMENT');
  }
  return changed;
};

/** Editorial wording changes can have a new Notice Version, but do not reinterpret history. */
export const assessMaterialPrivacyChange = (input: MaterialPrivacyChangeInput): PrivacyMaterialChangeAssessment => {
  const changedDimensions = changedPrivacyMaterialDimensions(input.previous, input.current);
  const material = changedDimensions.length > 0;
  const hasAffectedSubjects = input.affectedPrivacySubjectRefs.length > 0;
  const consentScopeChanged = input.previous.consentScopeKey !== input.current.consentScopeKey;
  const newConsentDecisionRequired = material && input.current.consentRequired && consentScopeChanged;
  const outcome = renoticeOutcome(material, hasAffectedSubjects, newConsentDecisionRequired);
  return {
    affectedPrivacySubjectRefs: [...input.affectedPrivacySubjectRefs],
    applyBlockedUntilCurrentRequirements: material,
    changedAt: input.changedAt,
    changedDimensions,
    changeRef: input.changeRef,
    current: input.current,
    historicalConsentDecisionsPreserved: true,
    historicalNoticeProvisionPreserved: true,
    materiality: material ? 'MATERIAL' : 'EDITORIAL',
    newConsentDecisionRequired,
    outcome,
    previous: input.previous,
  };
};
