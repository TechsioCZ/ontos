import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationOutcome, RecipientDecision } from '../../src/domain/catalog/decision.ts';
import { PrivacyAssessment, privacyEvidenceOf } from '../../src/domain/privacy/assess-privacy.ts';
import type { PrivacyAssessmentCase } from '../../src/domain/privacy/assess-privacy.ts';
import type { IndeterminateCause, UnavailableReason } from '../../src/domain/privacy/eligibility-gate.ts';
import { privacySuppressionReasons } from '../../src/domain/privacy/suppression.ts';
import {
  decideOrThrow,
  FIXTURE_ORIGINAL_ROLE,
  fixtureContext,
  fixtureRegistry,
  fixtureRequest,
  fixtureType,
  recipient,
} from './support/catalog-fixtures.ts';

/**
 * [#1396 BR-14 AC-02 AC-10] Decision time and handoff time speak ONE Privacy vocabulary: a Communications access problem, an
 * owner outage, an ambiguous context and a protected source are each reported as their own fact at both moments, and only a
 * real Privacy uncertainty is `PRIVACY_INDETERMINATE`.
 */
const assessedAt = DateTime.makeUnsafe(Date.UTC(2026, 10, 25, 12));
const scopeKey = 'fixture-scope-key';
const registry = fixtureRegistry(fixtureType());
const request = fixtureRequest();

/** The closed reason the DECISION gives a candidate whose Privacy answer was this assessment. */
const decisionTimeReason = (assessment: PrivacyAssessmentCase) => {
  const fact = recipient(FIXTURE_ORIGINAL_ROLE, 'contact-a', undefined, { privacy: privacyEvidenceOf(assessment) });
  const decision = decideOrThrow(registry, request, fixtureContext([fact]));
  return CommunicationOutcome.$match(decision.outcome, {
    Candidates: ({ candidates }) =>
      candidates.map(({ recipient: candidate }) =>
        RecipientDecision.$match(candidate, { Eligible: () => 'ELIGIBLE', Suppressed: ({ reason }) => reason }),
      ),
    NoMessage: ({ reason }) => [reason],
  });
};

/** The closed category the LAST STOPPABLE HANDOFF gives the same assessment. */
const handoffTimeCategory = (assessment: PrivacyAssessmentCase) =>
  privacySuppressionReasons(assessment).map(({ category }) => category);

const indeterminate = (cause: IndeterminateCause, expected: string) => ({
  assessment: PrivacyAssessment.Indeterminate({ assessedAt, cause, scopeKey }),
  expected,
});
const unavailable = (reason: UnavailableReason, expected: string) => ({
  assessment: PrivacyAssessment.Unavailable({ assessedAt, reason, scopeKey }),
  expected,
});

/** Keyed by the closed vocabulary of the owner, so a cause nobody classified here fails to compile. */
const INDETERMINATE = {
  CONTEXT_AMBIGUOUS: indeterminate('CONTEXT_AMBIGUOUS', 'PRIVACY_CONTEXT_AMBIGUOUS'),
  CONTEXT_NOT_SUPPORTED: indeterminate('CONTEXT_NOT_SUPPORTED', 'PRIVACY_INDETERMINATE'),
  EVIDENCE_INCONSISTENT: indeterminate('EVIDENCE_INCONSISTENT', 'PRIVACY_INDETERMINATE'),
  EVIDENCE_MISSING: indeterminate('EVIDENCE_MISSING', 'PRIVACY_INDETERMINATE'),
  EVIDENCE_SCOPE_MISMATCH: indeterminate('EVIDENCE_SCOPE_MISMATCH', 'PRIVACY_INDETERMINATE'),
  INPUTS_NOT_EVIDENCED: indeterminate('INPUTS_NOT_EVIDENCED', 'PRIVACY_INDETERMINATE'),
  PROTECTED_MATERIAL: indeterminate('PROTECTED_MATERIAL', 'SOURCE_PROTECTED'),
  PURPOSE_NOT_CURRENT: indeterminate('PURPOSE_NOT_CURRENT', 'PRIVACY_INDETERMINATE'),
} satisfies Record<IndeterminateCause, ReturnType<typeof indeterminate>>;

const UNAVAILABLE = {
  AUTHORIZATION_DENIED: unavailable('AUTHORIZATION_DENIED', 'PRIVACY_ACCESS_DENIED'),
  CONTEXT_AMBIGUOUS: unavailable('CONTEXT_AMBIGUOUS', 'PRIVACY_CONTEXT_AMBIGUOUS'),
  OWNER_UNAVAILABLE: unavailable('OWNER_UNAVAILABLE', 'PRIVACY_AUTHORITY_UNAVAILABLE'),
} satisfies Record<UnavailableReason, ReturnType<typeof unavailable>>;

describe('one Privacy stop vocabulary at decision time and at handoff time', () => {
  it.each(Object.entries(INDETERMINATE))(
    'an INDETERMINATE answer caused by %s is the same reason at both moments',
    (_cause, { assessment, expected }) => {
      expect(decisionTimeReason(assessment)).toEqual([expected]);
      expect(handoffTimeCategory(assessment)).toEqual([expected]);
    },
  );

  it.each(Object.entries(UNAVAILABLE))(
    'no Privacy decision because of %s is the same reason at both moments, never a Privacy uncertainty',
    (_reason, { assessment, expected }) => {
      expect(decisionTimeReason(assessment)).toEqual([expected]);
      expect(handoffTimeCategory(assessment)).toEqual([expected]);
    },
  );

  it('a proven prohibition is PRIVACY_NOT_ALLOWED at both moments', () => {
    const notAllowed = PrivacyAssessment.NotAllowed({ assessedAt, basis: 'EVALUATED_PROHIBITION', scopeKey });

    expect(decisionTimeReason(notAllowed)).toEqual(['PRIVACY_NOT_ALLOWED']);
    expect(handoffTimeCategory(notAllowed)).toEqual(['PRIVACY_NOT_ALLOWED']);
  });
});
