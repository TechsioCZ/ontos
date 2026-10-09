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
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema)),
  evidenceArtifactRef: Schema.toEncoded(Schema.OptionFromNullOr(ArtifactRefSchema)),
  language: LanguageTagSchema,
  noticeRef: PrivacyNoticeVersionRefSchema,
  recordedAt: PrivacyIsoTimestampSchema,
  versionId: Schema.toEncoded(UuidSchema.pipe(Schema.brand('PrivacyVersionId'))),
  versionNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  wording: Schema.toEncoded(Schema.OptionFromNullOr(TextSchema)),
});
export type PrivacyNoticeVersion = typeof PrivacyNoticeVersionSchema.Type;

export const CreatePrivacyNoticeVersionInputSchema = Schema.Struct({
  applicableScope: PrivacyApplicabilityScopeSchema,
  contentIdentity: ContentIdentitySchema,
  effectiveFrom: Schema.optionalKey(PrivacyIsoTimestampSchema),
  effectiveTo: Schema.optionalKey(Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema))),
  evidenceArtifactRef: Schema.toEncoded(Schema.OptionFromNullOr(ArtifactRefSchema)),
  language: LanguageTagSchema,
  wording: Schema.toEncoded(Schema.OptionFromNullOr(TextSchema)),
});
export type CreatePrivacyNoticeVersionInput = typeof CreatePrivacyNoticeVersionInputSchema.Type;

export { InvalidPrivacyNoticeContent } from './invalid-privacy-notice-content.ts';
export { PrivacyNoticeVersionNotFound } from './privacy-notice-version-not-found.ts';
