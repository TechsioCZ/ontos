import { Schema } from 'effect';

import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { PrivacyMaterialChangeAssessmentSchema } from './privacy-material-change.ts';
import { ConsentMaterialDimensionKindSchema } from './privacy-consent-scope.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';

const PurposeTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000));
const PurposeCodeSchema = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,63}$/u));
const UuidSchema = Schema.String.check(Schema.isUUID());

const ProcessingPurposeLifecycleSchema = Schema.Literals(['ACTIVE', 'RETIRED']);
const MaterialScopeRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const PurposeVersionMaterialScopeSchema = Schema.Struct({
  applicabilityKey: Schema.toEncoded(MaterialScopeRefSchema.pipe(Schema.brand('PrivacyApplicabilityKey'))),
  consentRequired: Schema.Boolean,
  consentScopeKey: Schema.toEncoded(
    Schema.toEncoded(Schema.OptionFromNullOr(MaterialScopeRefSchema)).pipe(Schema.brand('PrivacyConsentScopeKey')),
  ),
  controllerRef: MaterialScopeRefSchema,
  dataCategoryRefs: Schema.Array(MaterialScopeRefSchema),
  processingScopeRef: MaterialScopeRefSchema,
  recipientRefs: Schema.Array(MaterialScopeRefSchema),
});
export type PurposeVersionMaterialScope = typeof PurposeVersionMaterialScopeSchema.Type;

export const PurposeMaterialChangeRequestSchema = Schema.Struct({
  affectedPrivacySubjectRefs: Schema.Array(MaterialScopeRefSchema),
  changedAt: PrivacyIsoTimestampSchema,
  changeRef: MaterialScopeRefSchema,
});
const RequiredConsentDimensionsSchema = Schema.Array(ConsentMaterialDimensionKindSchema).check(
  Schema.isMaxLength(5),
  Schema.makeFilter((dimensions) =>
    new Set(dimensions).size === dimensions.length ? undefined : 'Required consent dimensions must be unique',
  ),
);

export const PurposeVersionSchema = Schema.Struct({
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema)),
  /** Immutable governance evidence retained with the version that it authorized. */
  materialChangeAssessment: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyMaterialChangeAssessmentSchema)),
  /** Absent only on legacy versions; a later revision then fails closed. */
  materialScope: Schema.optionalKey(Schema.toEncoded(Schema.OptionFromNullOr(PurposeVersionMaterialScopeSchema))),
  meaning: PurposeTextSchema,
  recordedAt: PrivacyIsoTimestampSchema,
  /** Material dimensions required by this authoritative catalog version. */
  requiredConsentDimensions: Schema.optionalKey(RequiredConsentDimensionsSchema),
  versionId: Schema.toEncoded(UuidSchema.pipe(Schema.brand('PrivacyVersionId'))),
  versionNumber: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PurposeVersion = typeof PurposeVersionSchema.Type;

export const ProcessingPurposeSchema = Schema.Struct({
  businessCode: PurposeCodeSchema,
  createdAt: PrivacyIsoTimestampSchema,
  governanceOwnerId: Schema.toEncoded(UuidSchema.pipe(Schema.brand('PrivacyGovernanceOwnerId'))),
  legalEntityId: Schema.toEncoded(UuidSchema.pipe(Schema.brand('PrivacyLegalEntityId'))),
  lifecycle: ProcessingPurposeLifecycleSchema,
  purposeRef: ProcessingPurposeRefSchema,
  retiredAt: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema)),
  versions: Schema.Array(PurposeVersionSchema).check(Schema.isMinLength(1)),
});
export type ProcessingPurpose = typeof ProcessingPurposeSchema.Type;

export const CreateProcessingPurposeInputSchema = Schema.Struct({
  businessCode: PurposeCodeSchema,
  effectiveFrom: PrivacyIsoTimestampSchema,
  governanceOwnerId: Schema.toEncoded(UuidSchema.pipe(Schema.brand('PrivacyGovernanceOwnerId'))),
  materialScope: Schema.optionalKey(PurposeVersionMaterialScopeSchema),
  meaning: PurposeTextSchema,
  requiredConsentDimensions: Schema.optionalKey(RequiredConsentDimensionsSchema),
});
export type CreateProcessingPurposeInput = typeof CreateProcessingPurposeInputSchema.Type;

export const CreatePurposeVersionInputSchema = Schema.Struct({
  effectiveFrom: PrivacyIsoTimestampSchema,
  materialChange: PurposeMaterialChangeRequestSchema,
  materialScope: PurposeVersionMaterialScopeSchema,
  meaning: PurposeTextSchema,
  requiredConsentDimensions: Schema.optionalKey(RequiredConsentDimensionsSchema),
});
export type CreatePurposeVersionInput = typeof CreatePurposeVersionInputSchema.Type;

export { PurposeNotFound } from './purpose-not-found.ts';
export { PurposeVersionConflict } from './purpose-version-conflict.ts';
