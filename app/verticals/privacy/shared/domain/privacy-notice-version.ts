/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Schema } from 'effect';

import { PrivacyApplicabilityScopeSchema } from './privacy-applicability.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { PrivacyNoticeVersionRefSchema } from '../resources/privacy-notice-version.ts';

const UuidSchema = Schema.String.check(Schema.isUUID());
const LanguageTagSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u));
const TextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100_000));
const ContentIdentitySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const ArtifactRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const PrivacyNoticeVersionSchema = Schema.Struct({
  applicableScope: PrivacyApplicabilityScopeSchema,
  contentIdentity: ContentIdentitySchema,
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: Schema.NullOr(PrivacyIsoTimestampSchema),
  evidenceArtifactRef: Schema.NullOr(ArtifactRefSchema),
  language: LanguageTagSchema,
  noticeRef: PrivacyNoticeVersionRefSchema,
  recordedAt: PrivacyIsoTimestampSchema,
  versionId: UuidSchema,
  versionNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  wording: Schema.NullOr(TextSchema),
});
export type PrivacyNoticeVersion = typeof PrivacyNoticeVersionSchema.Type;

export const CreatePrivacyNoticeVersionInputSchema = Schema.Struct({
  applicableScope: PrivacyApplicabilityScopeSchema,
  contentIdentity: ContentIdentitySchema,
  effectiveFrom: Schema.optionalKey(PrivacyIsoTimestampSchema),
  effectiveTo: Schema.optionalKey(Schema.NullOr(PrivacyIsoTimestampSchema)),
  evidenceArtifactRef: Schema.NullOr(ArtifactRefSchema),
  language: LanguageTagSchema,
  wording: Schema.NullOr(TextSchema),
});
export type CreatePrivacyNoticeVersionInput = typeof CreatePrivacyNoticeVersionInputSchema.Type;

export { InvalidPrivacyNoticeContent } from './invalid-privacy-notice-content.ts';
export { PrivacyNoticeVersionNotFound } from './privacy-notice-version-not-found.ts';
