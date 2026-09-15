/* eslint-disable effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Schema } from 'effect';

import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';

const PurposeTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000));
const PurposeCodeSchema = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,63}$/u));
const UuidSchema = Schema.String.check(Schema.isUUID());

const ProcessingPurposeLifecycleSchema = Schema.Literals(['ACTIVE', 'RETIRED']);

export const PurposeVersionSchema = Schema.Struct({
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema)),
  meaning: PurposeTextSchema,
  recordedAt: PrivacyIsoTimestampSchema,
  versionId: UuidSchema,
  versionNumber: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PurposeVersion = typeof PurposeVersionSchema.Type;

export const ProcessingPurposeSchema = Schema.Struct({
  businessCode: PurposeCodeSchema,
  createdAt: PrivacyIsoTimestampSchema,
  governanceOwnerId: UuidSchema,
  legalEntityId: UuidSchema,
  lifecycle: ProcessingPurposeLifecycleSchema,
  purposeRef: ProcessingPurposeRefSchema,
  retiredAt: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema)),
  versions: Schema.Array(PurposeVersionSchema).check(Schema.isMinLength(1)),
});
export type ProcessingPurpose = typeof ProcessingPurposeSchema.Type;

export const CreateProcessingPurposeInputSchema = Schema.Struct({
  businessCode: PurposeCodeSchema,
  effectiveFrom: PrivacyIsoTimestampSchema,
  governanceOwnerId: UuidSchema,
  meaning: PurposeTextSchema,
});
export type CreateProcessingPurposeInput = typeof CreateProcessingPurposeInputSchema.Type;

export const CreatePurposeVersionInputSchema = Schema.Struct({
  effectiveFrom: PrivacyIsoTimestampSchema,
  meaning: PurposeTextSchema,
});
export type CreatePurposeVersionInput = typeof CreatePurposeVersionInputSchema.Type;

export { PurposeNotFound } from './purpose-not-found.ts';
export { PurposeVersionConflict } from './purpose-version-conflict.ts';
