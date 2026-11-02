import { DateTime, Option, Schema } from 'effect';

import { PrivacyApplicabilityScopeSchema } from './privacy-applicability.ts';
import { comparePrivacyInstants, PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { PrivacyNoticeVersionRefSchema } from '../resources/privacy-notice-version.ts';

const UuidSchema = Schema.String.check(Schema.isUUID());
const LanguageTagSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u));
const TextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100_000));
const ContentIdentitySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const ArtifactRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

/** Compares retained Notice instants without rounding their supported fractional precision. */
export const comparePrivacyNoticeInstants = (left: string, right: string): number | undefined => {
  if (!Schema.is(PrivacyIsoTimestampSchema)(left) || !Schema.is(PrivacyIsoTimestampSchema)(right)) {
    return undefined;
  }
  const leftWholeSecond = `${left.slice(0, 19)}Z`;
  const rightWholeSecond = `${right.slice(0, 19)}Z`;
  const leftInstant = DateTime.make(leftWholeSecond);
  const rightInstant = DateTime.make(rightWholeSecond);
  if (
    Option.isNone(leftInstant) ||
    Option.isNone(rightInstant) ||
    DateTime.formatIso(leftInstant.value) !== `${left.slice(0, 19)}.000Z` ||
    DateTime.formatIso(rightInstant.value) !== `${right.slice(0, 19)}.000Z`
  ) {
    return undefined;
  }
  const seconds = comparePrivacyInstants(leftWholeSecond, rightWholeSecond);
  if (seconds === undefined || seconds !== 0) {
    return seconds;
  }
  const leftFraction = left.length === 20 ? '' : left.slice(20, -1);
  const rightFraction = right.length === 20 ? '' : right.slice(20, -1);
  const precision = Math.max(leftFraction.length, rightFraction.length);
  const leftDigits = leftFraction.padEnd(precision, '0');
  const rightDigits = rightFraction.padEnd(precision, '0');
  if (leftDigits === rightDigits) {
    return 0;
  }
  return leftDigits < rightDigits ? -1 : 1;
};

export const PrivacyNoticeIsoTimestampSchema = PrivacyIsoTimestampSchema.check(
  Schema.makeFilter((value) =>
    comparePrivacyNoticeInstants(value, value) === 0 ? undefined : 'invalid Notice UTC timestamp',
  ),
);

export const PrivacyNoticeVersionSchema = Schema.Struct({
  applicableScope: PrivacyApplicabilityScopeSchema,
  contentIdentity: ContentIdentitySchema,
  effectiveFrom: PrivacyNoticeIsoTimestampSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyNoticeIsoTimestampSchema)),
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
  effectiveFrom: Schema.optionalKey(PrivacyNoticeIsoTimestampSchema),
  effectiveTo: Schema.optionalKey(Schema.toEncoded(Schema.OptionFromNullOr(PrivacyNoticeIsoTimestampSchema))),
  evidenceArtifactRef: Schema.toEncoded(Schema.OptionFromNullOr(ArtifactRefSchema)),
  language: LanguageTagSchema,
  wording: Schema.toEncoded(Schema.OptionFromNullOr(TextSchema)),
});
export type CreatePrivacyNoticeVersionInput = typeof CreatePrivacyNoticeVersionInputSchema.Type;

export { InvalidPrivacyNoticeContent } from './invalid-privacy-notice-content.ts';
export { PrivacyNoticeVersionNotFound } from './privacy-notice-version-not-found.ts';
