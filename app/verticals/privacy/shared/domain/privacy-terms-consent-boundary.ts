import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { Schema } from 'effect';

import { PrivacyNoticeProvisionSchema } from './privacy-notice-provision.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Timestamp = PrivacyIsoTimestampSchema;

/** A Terms acceptance is a legal/product fact, not evidence of notice provision or consent. */
export const TermsAcceptanceSchema = Schema.Struct({
  acceptanceId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyAcceptanceId'))),
  acceptedAt: Timestamp,
  anonymousContextRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  evidenceRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  privacySubjectRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  recordedAt: Timestamp,
  termsVersionRef: Ref,
});
export type TermsAcceptance = typeof TermsAcceptanceSchema.Type;

/** Consent is represented only when the submission contains an explicit decision and scope. */
export const ExplicitConsentDecisionSchema = Schema.Struct({
  controllerRef: Ref,
  decidedAt: Timestamp,
  decision: Schema.Literals(['GRANTED', 'REFUSED', 'WITHDRAWN']),
  decisionId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyDecisionId'))),
  evidenceRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
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
  consentDecision: Schema.toEncoded(Schema.OptionFromNullOr(ExplicitConsentDecisionSchema)),
  noticeProvision: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyNoticeProvisionSchema)),
  submissionId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacySubmissionId'))),
  termsAcceptance: Schema.toEncoded(Schema.OptionFromNullOr(TermsAcceptanceSchema)),
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
