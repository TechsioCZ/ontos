/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-string-timestamp-schema, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Schema } from 'effect';

import { PrivacyNoticeProvisionSchema } from './privacy-notice-provision.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u));

/** A Terms acceptance is a legal/product fact, not evidence of notice provision or consent. */
export const TermsAcceptanceSchema = Schema.Struct({
  acceptanceId: Ref,
  acceptedAt: Timestamp,
  anonymousContextRef: Schema.NullOr(Ref),
  evidenceRef: Schema.NullOr(Ref),
  privacySubjectRef: Schema.NullOr(Ref),
  recordedAt: Timestamp,
  termsVersionRef: Ref,
});
export type TermsAcceptance = typeof TermsAcceptanceSchema.Type;

/** Consent is represented only when the submission contains an explicit decision and scope. */
export const ExplicitConsentDecisionSchema = Schema.Struct({
  controllerRef: Ref,
  decidedAt: Timestamp,
  decision: Schema.Literals(['GRANTED', 'REFUSED', 'WITHDRAWN']),
  decisionId: Ref,
  evidenceRef: Schema.NullOr(Ref),
  privacySubjectRef: Ref,
  processingPurposeRef: Ref,
  processingScopeRef: Ref,
  recordedAt: Timestamp,
});
export type ExplicitConsentDecision = typeof ExplicitConsentDecisionSchema.Type;

/**
 * A combined form is an envelope only. Each nullable member is an independently asserted fact;
 * no member is derived from either of the other two.
 */
export const CombinedPrivacySubmissionSchema = Schema.Struct({
  consentDecision: Schema.NullOr(ExplicitConsentDecisionSchema),
  noticeProvision: Schema.NullOr(PrivacyNoticeProvisionSchema),
  submissionId: Ref,
  termsAcceptance: Schema.NullOr(TermsAcceptanceSchema),
});
export type CombinedPrivacySubmission = typeof CombinedPrivacySubmissionSchema.Type;

export interface CombinedPrivacyFacts {
  readonly consentDecision: ExplicitConsentDecision | null;
  readonly noticeProvision: CombinedPrivacySubmission['noticeProvision'];
  readonly termsAcceptance: TermsAcceptance | null;
}

/** Preserve only explicitly submitted facts; Terms and Notice never imply Consent. */
export const materializeCombinedPrivacyFacts = (submission: CombinedPrivacySubmission): CombinedPrivacyFacts => ({
  consentDecision: submission.consentDecision,
  noticeProvision: submission.noticeProvision,
  termsAcceptance: submission.termsAcceptance,
});

export const validateTermsAcceptance = (input: TermsAcceptance): string | undefined => {
  const hasSubject = input.privacySubjectRef !== null;
  const hasAnonymousContext = input.anonymousContextRef !== null;
  if (hasSubject === hasAnonymousContext) {
    return 'Exactly one subject or anonymous context is required';
  }
  if (input.recordedAt < input.acceptedAt) {
    return 'Recorded time cannot precede acceptance time';
  }
  return undefined;
};
