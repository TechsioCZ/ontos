import { describe, expect, it } from 'effect-rstest';

import {
  materializeCombinedPrivacyFacts,
  validateTermsAcceptance,
} from '../../shared/domain/privacy-terms-consent-boundary.ts';
import type { CombinedPrivacySubmission, TermsAcceptance } from '../../shared/domain/privacy-terms-consent-boundary.ts';
import type { PrivacyNoticeProvision } from '../../shared/domain/privacy-notice-provision.ts';

const terms: TermsAcceptance = {
  acceptanceId: 'terms-acceptance:1',
  acceptedAt: '2026-01-01T10:00:00Z',
  anonymousContextRef: null,
  evidenceRef: 'evidence:terms:1',
  privacySubjectRef: 'subject:1',
  recordedAt: '2026-01-01T10:00:01Z',
  termsVersionRef: 'terms:v3',
};
const noticeProvision = (noticeVersionRef: string, provisionId: string): PrivacyNoticeProvision => ({
  actionRef: 'action:notice-provision',
  anonymousContextRef: null,
  businessInteractionRef: 'interaction:one',
  channel: 'web',
  controllerRef: 'controller:one',
  evidenceRef: 'evidence:notice-provision',
  failureReason: null,
  noticeVersionRef,
  outcome: 'PROVEN_PROVISION',
  privacySubjectRef: 'subject:1',
  processingPurposeRef: 'purpose:account',
  processingScopeRef: 'scope:account',
  providedLanguage: 'en',
  provisionedAt: '2026-01-01T10:00:00Z',
  provisionId,
  recordedAt: '2026-01-01T10:00:01Z',
  supersedesProvisionRef: null,
});

describe('Terms, notice, and consent boundary', () => {
  it('keeps independently submitted facts separate', () => {
    const submission: CombinedPrivacySubmission = {
      consentDecision: null,
      noticeProvision: noticeProvision('notice:v1', 'provision:one'),
      submissionId: 'submission:1',
      termsAcceptance: terms,
    };
    const facts = materializeCombinedPrivacyFacts(submission);
    expect(facts.termsAcceptance).toEqual(terms);
    expect(facts.noticeProvision).toEqual(submission.noticeProvision);
    expect(facts.consentDecision).toBeNull();
  });

  it('does not infer terms acceptance or notice provision from explicit consent', () => {
    const submission: CombinedPrivacySubmission = {
      consentDecision: {
        controllerRef: 'controller:1',
        decidedAt: '2026-01-01T10:00:00Z',
        decision: 'GRANTED',
        decisionId: 'consent:1',
        evidenceRef: 'evidence:consent:1',
        privacySubjectRef: 'subject:1',
        processingPurposeRef: 'purpose:marketing',
        processingScopeRef: 'scope:marketing',
        recordedAt: '2026-01-01T10:00:01Z',
      },
      noticeProvision: null,
      submissionId: 'submission:2',
      termsAcceptance: null,
    };
    const facts = materializeCombinedPrivacyFacts(submission);
    expect(facts.termsAcceptance).toBeNull();
    expect(facts.noticeProvision).toBeNull();
    expect(facts.consentDecision?.decision).toBe('GRANTED');
  });

  it('keeps all three facts independently addressable in one form submission', () => {
    const provision = noticeProvision('notice:v2', 'provision:two');
    const submission: CombinedPrivacySubmission = {
      consentDecision: {
        controllerRef: 'controller:1',
        decidedAt: '2026-01-01T10:00:00Z',
        decision: 'GRANTED',
        decisionId: 'consent:2',
        evidenceRef: 'evidence:consent:2',
        privacySubjectRef: 'subject:1',
        processingPurposeRef: 'purpose:account',
        processingScopeRef: 'scope:account',
        recordedAt: '2026-01-01T10:00:01Z',
      },
      noticeProvision: provision,
      submissionId: 'submission:3',
      termsAcceptance: terms,
    };
    const facts = materializeCombinedPrivacyFacts(submission);
    expect(facts.termsAcceptance?.acceptanceId).toBe('terms-acceptance:1');
    expect(facts.noticeProvision?.noticeVersionRef).toBe('notice:v2');
    expect(facts.consentDecision?.decisionId).toBe('consent:2');
  });

  it('validates terms identity and timestamps independently', () => {
    expect(validateTermsAcceptance(terms)).toBeUndefined();
    expect(validateTermsAcceptance({ ...terms, anonymousContextRef: 'anonymous:1' })).toContain('Exactly one');
    expect(validateTermsAcceptance({ ...terms, recordedAt: '2025-12-31T23:59:59Z' })).toContain('precede');
  });
});
