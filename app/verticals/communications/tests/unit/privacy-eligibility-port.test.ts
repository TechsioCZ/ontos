import { Effect, Fiber, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationOutcome, RecipientDecision } from '../../src/domain/catalog/decision.ts';
import type { MessageIntentCandidate } from '../../src/domain/catalog/decision.ts';
import { CommunicationResourceRefSchema, RecipientRoleSchema } from '../../src/domain/catalog/vocabulary.ts';
import {
  assessPrivacyEligibility,
  assessmentCoversScope,
  privacyEvidenceOf,
} from '../../src/domain/privacy/assess-privacy.ts';
import {
  ProcessingEligibilityVerdict,
  unavailableProcessingEligibilityGateLayer,
} from '../../src/domain/privacy/eligibility-gate.ts';
import type { ProcessingEligibilityQuery } from '../../src/domain/privacy/eligibility-gate.ts';
import { processingScopeKey, ProcessingScopeSchema } from '../../src/domain/privacy/processing-scope.ts';
import {
  eligibilityVerdictOf,
  PrivacySourceEligibilityResponseSchema,
} from '../../src/domain/privacy/source-eligibility-response.ts';
import { assessRecipients, recipientFactOf } from '../../src/domain/recipient/assess-recipients.ts';
import {
  decideOrThrow,
  FIXTURE_ORIGINAL_ROLE,
  fixtureContext,
  fixtureRegistry,
  fixtureRequest,
  fixtureType,
} from './support/catalog-fixtures.ts';
import {
  FIXTURE_MARKETING_PURPOSE,
  privacyAllowed,
  privacyAnswersFor,
  privacyDying,
  privacyGateDouble,
  privacyHanging,
  privacyIndeterminate,
  privacyNotAllowed,
  privacyThrowing,
  privacyUnavailable,
  processingScope,
} from './support/privacy-fixtures.ts';
import type { PrivacyAnswer } from './support/privacy-fixtures.ts';
import { assessmentSummary, verdictSummary } from './support/privacy-summaries.ts';
import { binding, evaluationInput, gateDouble, TEST_GATE_CHECK_TIMEOUT, usable } from './support/recipient-fixtures.ts';

const type = fixtureType();
const request = fixtureRequest({ purpose: type.purpose });
const decodeRole = Schema.decodeSync(RecipientRoleSchema);
const decodeRef = Schema.decodeSync(CommunicationResourceRefSchema);

const queryFor = (recipientId: string, scope = processingScope(recipientId)): ProcessingEligibilityQuery => ({
  occurrence: request.occurrence,
  recipient: {
    recipientRef: decodeRef({ moduleId: 'fixture.party', resourceId: recipientId, resourceType: 'fixture.recipient' }),
    role: decodeRole(FIXTURE_ORIGINAL_ROLE),
  },
  scope,
  sourceModule: request.source.moduleKey,
  tenantId: request.tenantId,
  typeId: type.typeId,
});

const assess = (answers: Readonly<Record<string, PrivacyAnswer>>, query = queryFor('recipient-a')) => {
  const double = privacyGateDouble(answers);
  return { ...double, run: assessPrivacyEligibility(query).pipe(Effect.provide(double.layer)) };
};

const marketingScope = (scope: ReturnType<typeof processingScope>) => ({
  ...scope,
  purposeRef: 'fixture-marketing-purpose',
});

describe('#1396 Rule: Privacy ALLOWED, NOT_ALLOWED and INDETERMINATE are three distinct facts (BR-03, BR-04)', () => {
  it.effect(
    'Scenario: a Current ALLOWED lets the message continue to the independent checks, and claims nothing more',
    () =>
      Effect.gen(function* currentAllowed() {
        const assessment = yield* assess({ 'recipient-a': privacyAllowed }).run;

        expect(assessmentSummary(assessment)).toEqual({ kind: 'Allowed' });
        expect(privacyEvidenceOf(assessment)).toBe('ALLOWED');
        // The assessment is a Privacy fact only: it has no send, delivery, Permission or provider field.
        expect(Object.keys(assessment).toSorted()).toEqual(['_tag', 'assessedAt', 'evidence', 'scopeKey']);
      }),
  );

  it.effect(
    'Scenario: a Current NOT_ALLOWED is a proven prohibition carrying the owner evidence for exactly this scope',
    () =>
      Effect.gen(function* currentNotAllowed() {
        const assessment = yield* assess({
          'recipient-a': privacyNotAllowed(['fixture_current_restriction:restriction-1']),
        }).run;

        expect(assessmentSummary(assessment)).toEqual({
          basis: 'EVALUATED_PROHIBITION',
          kind: 'NotAllowed',
          reasonCodes: ['fixture_current_restriction:restriction-1'],
        });
        expect(privacyEvidenceOf(assessment)).toBe('NOT_ALLOWED');
      }),
  );

  it.effect('Scenario: a Current INDETERMINATE is uncertainty and is never reported as a proven prohibition', () =>
    Effect.gen(function* currentIndeterminate() {
      const assessment = yield* assess({ 'recipient-a': privacyIndeterminate }).run;

      expect(assessmentSummary(assessment)).toEqual({ cause: 'INPUTS_NOT_EVIDENCED', kind: 'Indeterminate' });
      expect(privacyEvidenceOf(assessment)).toBe('INDETERMINATE');
    }),
  );

  it.effect(
    'Scenario: a denial that carries no owner evidence is not a prohibition (explicit deny only with evidence)',
    () =>
      Effect.gen(function* denialWithoutEvidence() {
        const double = privacyGateDouble({
          'recipient-a': () =>
            Effect.succeed(ProcessingEligibilityVerdict.NotAllowed({ basis: 'EVALUATED_PROHIBITION' })),
        });
        const assessment = yield* assessPrivacyEligibility(queryFor('recipient-a')).pipe(Effect.provide(double.layer));

        expect(assessmentSummary(assessment)).toEqual({ cause: 'EVIDENCE_MISSING', kind: 'Indeterminate' });
      }),
  );
});

describe('#1396 Rule: no decision is not a Privacy decision (authorization, outage and ambiguous context)', () => {
  it.effect.each([
    ['access to the Privacy Read was denied', 'AUTHORIZATION_DENIED'],
    ['the owner is unavailable', 'OWNER_UNAVAILABLE'],
    ['the context is ambiguous', 'CONTEXT_AMBIGUOUS'],
  ] as const)('Scenario: %s is its own reason and never a NOT_ALLOWED', ([, reason]) =>
    Effect.gen(function* notADecision() {
      const assessment = yield* assess({ 'recipient-a': privacyUnavailable(reason) }).run;

      expect(assessmentSummary(assessment)).toEqual({ kind: 'Unavailable', reason });
      expect(privacyEvidenceOf(assessment)).toBe('INDETERMINATE');
    }),
  );

  it.effect.each([
    ['throws', privacyThrowing],
    ['dies', privacyDying],
  ] as const)(
    'Scenario: an adapter that %s fails closed as an unavailable owner for this question only',
    ([, answer]) =>
      Effect.gen(function* defectiveAdapter() {
        const assessment = yield* assess({ 'recipient-a': answer, 'recipient-b': privacyAllowed }).run;

        expect(assessmentSummary(assessment)).toEqual({ kind: 'Unavailable', reason: 'OWNER_UNAVAILABLE' });
      }),
  );

  it.effect('Scenario: an owner that never answers fails closed after its deadline', () =>
    Effect.gen(function* hangingOwner() {
      const fiber = yield* Effect.forkChild(assess({ 'recipient-a': privacyHanging }).run);
      yield* TestClock.adjust(TEST_GATE_CHECK_TIMEOUT);

      expect(assessmentSummary(yield* Fiber.join(fiber))).toEqual({ kind: 'Unavailable', reason: 'OWNER_UNAVAILABLE' });
    }),
  );

  it.effect('Scenario: the production default before the real client is wired allows nothing', () =>
    Effect.gen(function* unwiredProduction() {
      const assessment = yield* assessPrivacyEligibility(queryFor('recipient-a')).pipe(
        Effect.provide(unavailableProcessingEligibilityGateLayer({ checkTimeout: TEST_GATE_CHECK_TIMEOUT })),
      );

      expect(assessmentSummary(assessment)).toEqual({ kind: 'Unavailable', reason: 'OWNER_UNAVAILABLE' });
    }),
  );
});

describe('#1396 Rule: an ALLOWED is never reused across purpose, controller, channel or subject (BR-01, BR-05)', () => {
  it.effect('Scenario: a historical marketing ALLOWED is not applied to the transactional purpose', () =>
    Effect.gen(function* marketingAllowed() {
      const assessment = yield* assess({ 'recipient-a': privacyAnswersFor(marketingScope, 'ALLOWED') }).run;

      expect(assessmentSummary(assessment)).toEqual({ cause: 'EVIDENCE_SCOPE_MISMATCH', kind: 'Indeterminate' });
      expect(privacyEvidenceOf(assessment)).not.toBe('ALLOWED');
    }),
  );

  it.effect('Scenario: a prohibition of an unrelated purpose (a marketing unsubscribe) does not block this one', () =>
    Effect.gen(function* unrelatedProhibition() {
      const assessment = yield* assess({ 'recipient-a': privacyAnswersFor(marketingScope, 'NOT_ALLOWED') }).run;

      // It is neither applied as a prohibition of this scope nor allowed: it is simply not evidence about it.
      expect(assessmentSummary(assessment)).toEqual({ cause: 'EVIDENCE_SCOPE_MISMATCH', kind: 'Indeterminate' });
    }),
  );

  it.each([
    ['controller', { controllerRef: 'fixture-other-controller' }],
    ['purpose version', { purposeVersionId: 'fixture-purpose-version-2' }],
    ['channel', { channel: 'sms' }],
    ['data scope', { dataCategoryRefs: ['fixture:contact', 'fixture:profile'] }],
    ['recipient dimension', { recipientRefs: ['fixture.other'] }],
    ['catalog purpose', { catalogPurposeRef: FIXTURE_MARKETING_PURPOSE }],
  ] as const)('Scenario: another %s is another scope with another key', (_name, change) => {
    const base = processingScope('recipient-a');
    expect(processingScopeKey(processingScope('recipient-a', change))).not.toBe(processingScopeKey(base));
  });

  it('Scenario: another subject is another scope, and list order never changes a scope', () => {
    const base = processingScope('recipient-a');
    expect(processingScopeKey(processingScope('recipient-b'))).not.toBe(processingScopeKey(base));
    expect(processingScopeKey(processingScope('recipient-a', { dataCategoryRefs: ['fixture:b', 'fixture:a'] }))).toBe(
      processingScopeKey(processingScope('recipient-a', { dataCategoryRefs: ['fixture:a', 'fixture:b'] })),
    );
  });

  it.effect(
    'Scenario: a retained ALLOWED covers only its own scope and every handoff asks Privacy again (no TTL)',
    () =>
      Effect.gen(function* noReuse() {
        const double = privacyGateDouble({ 'recipient-a': privacyAllowed });
        const first = yield* assessPrivacyEligibility(queryFor('recipient-a')).pipe(Effect.provide(double.layer));
        yield* TestClock.adjust('30 days');
        yield* assessPrivacyEligibility(queryFor('recipient-a')).pipe(Effect.provide(double.layer));

        expect(double.queries).toHaveLength(2);
        expect(assessmentCoversScope(first, processingScope('recipient-a'))).toBe(true);
        expect(assessmentCoversScope(first, processingScope('recipient-a', { channel: 'sms' }))).toBe(false);
        expect(assessmentCoversScope(first, processingScope('recipient-b'))).toBe(false);
      }),
  );

  it('Scenario: the scope cannot carry an e-mail address or any field that would identify a subject by address', () => {
    const decode = Schema.decodeUnknownResult(ProcessingScopeSchema, { onExcessProperty: 'error' });
    expect(Result.isFailure(decode({ ...processingScope('recipient-a'), emailAddress: 'someone@example.test' }))).toBe(
      true,
    );
    expect(
      Result.isFailure(
        decode({ ...processingScope('recipient-a'), subject: { address: 'someone@example.test', kind: 'EMAIL' } }),
      ),
    ).toBe(true);
  });
});

describe('#1396 Rule: an Auth occurrence has a Privacy scope without any usable secret (AC-12)', () => {
  it.effect.each([['verification'], ['password-reset'], ['otp']] as const)(
    'Scenario Outline: the %s occurrence is evaluated for its own scope and the stored correlation holds no link, reset or OTP',
    ([purpose]) =>
      Effect.gen(function* authOccurrence() {
        const scope = processingScope(`auth-${purpose}`, {
          dataCategoryRefs: [`fixture:auth-${purpose}`],
        });
        const assessment = yield* assessPrivacyEligibility(queryFor(`auth-${purpose}`, scope)).pipe(
          Effect.provide(privacyGateDouble({ [`auth-${purpose}`]: privacyAllowed }).layer),
        );

        expect(assessmentSummary(assessment)).toEqual({ kind: 'Allowed' });
        expect(JSON.stringify(assessment)).not.toMatch(/https?:|token|secret|\b\d{6}\b/iu);
        const decode = Schema.decodeUnknownResult(ProcessingScopeSchema, { onExcessProperty: 'error' });
        expect(Result.isFailure(decode({ ...scope, resetToken: 'fixture-token', verificationLink: 'https://x' }))).toBe(
          true,
        );
      }),
  );
});

type OwnerResponse = typeof PrivacySourceEligibilityResponseSchema.Encoded;
const owner = (response: OwnerResponse) => Schema.decodeUnknownSync(PrivacySourceEligibilityResponseSchema)(response);
const evidenceDocument = (outcome: 'ALLOWED' | 'INDETERMINATE' | 'NOT_ALLOWED') => ({
  authoritativeReferences: [{ kind: 'PRIVACY_LEGAL_BASIS_ASSIGNMENT', reference: 'assignment-1', revision: '1' }],
  evaluatedScope: {
    controllerRef: 'fixture-controller',
    dataCategoryRefs: ['fixture:contact'],
    operation: 'FIXTURE_SEND_MESSAGE',
    processingScopeRef: { scopeId: 'fixture-scope', scopeType: 'fixture.processing-scope' },
    purposeRef: 'fixture-purpose',
    purposeVersionId: 'fixture-purpose-version-1',
    recipientRefs: ['fixture.communications'],
    subjectRef: { resourceId: 'fixture-privacy-subject' },
  },
  outcome,
  policyRevisions: [],
  reasonCodes: [`fixture_${outcome.toLowerCase()}`],
  trustedDecisionTime: '2026-11-19T10:00:00.000Z',
});
const EVALUATED_AT = '2026-11-19T10:00:00.000Z';
const allowedResponse = (outcome: 'ALLOWED' | 'INDETERMINATE' | 'NOT_ALLOWED') =>
  owner({ evaluatedAt: EVALUATED_AT, evidence: evidenceDocument(outcome), outcome: 'ALLOWED' });
const deniedResponse = (reason: 'AUTHORITY_NOT_CURRENT' | 'PROCESSING_NOT_ALLOWED' | 'PROTECTED_MATERIAL') =>
  owner({ evaluatedAt: EVALUATED_AT, outcome: 'DENIED', reason });
const evaluatedDenial = (outcome: 'INDETERMINATE' | 'NOT_ALLOWED', evidenceOutcome = outcome) =>
  owner({
    eligibility: { evidence: evidenceDocument(evidenceOutcome), outcome },
    evaluatedAt: EVALUATED_AT,
    outcome: 'DENIED',
    reason: 'PROCESSING_NOT_ALLOWED',
  });

describe('#1396 Rule: the Privacy owner public response maps to the three outcomes only on matching owner evidence', () => {
  it('Scenario: ALLOWED needs evidence that itself says ALLOWED', () => {
    expect(verdictSummary(eligibilityVerdictOf(allowedResponse('ALLOWED')))).toEqual({ kind: 'Allowed' });
    expect(verdictSummary(eligibilityVerdictOf(allowedResponse('NOT_ALLOWED')))).toEqual({
      cause: 'EVIDENCE_INCONSISTENT',
      kind: 'Indeterminate',
    });
  });

  it('Scenario: the owner NOT_ALLOWED and INDETERMINATE stay distinct although both are DENIED/PROCESSING_NOT_ALLOWED', () => {
    expect(verdictSummary(eligibilityVerdictOf(evaluatedDenial('NOT_ALLOWED')))).toEqual({
      basis: 'EVALUATED_PROHIBITION',
      kind: 'NotAllowed',
    });
    expect(verdictSummary(eligibilityVerdictOf(evaluatedDenial('INDETERMINATE')))).toEqual({
      cause: 'INPUTS_NOT_EVIDENCED',
      kind: 'Indeterminate',
    });
  });

  it('Scenario: a denial without an evaluation is not a prohibition, and evidence that contradicts its outcome is refused', () => {
    expect(verdictSummary(eligibilityVerdictOf(deniedResponse('PROCESSING_NOT_ALLOWED')))).toEqual({
      cause: 'EVIDENCE_MISSING',
      kind: 'Indeterminate',
    });
    expect(verdictSummary(eligibilityVerdictOf(evaluatedDenial('NOT_ALLOWED', 'INDETERMINATE')))).toEqual({
      cause: 'EVIDENCE_INCONSISTENT',
      kind: 'Indeterminate',
    });
  });

  it('Scenario: no exact current Privacy context is nothing evaluated, and a recorded protection is a prohibition', () => {
    expect(verdictSummary(eligibilityVerdictOf(deniedResponse('AUTHORITY_NOT_CURRENT')))).toEqual({
      cause: 'CONTEXT_NOT_SUPPORTED',
      kind: 'Indeterminate',
    });
    expect(verdictSummary(eligibilityVerdictOf(deniedResponse('PROTECTED_MATERIAL')))).toEqual({
      basis: 'PROTECTED_MATERIAL',
      kind: 'NotAllowed',
    });
  });

  it.effect(
    'Scenario: an owner decision for another use than the question is never applied (stale or foreign evidence)',
    () =>
      Effect.gen(function* foreignEvidence() {
        const document = evidenceDocument('ALLOWED');
        const foreign = owner({
          evaluatedAt: EVALUATED_AT,
          evidence: {
            ...document,
            evaluatedScope: { ...document.evaluatedScope, controllerRef: 'fixture-other-controller' },
          },
          outcome: 'ALLOWED',
        });
        const double = privacyGateDouble({ 'recipient-a': () => Effect.succeed(eligibilityVerdictOf(foreign)) });
        const assessment = yield* assessPrivacyEligibility(queryFor('recipient-a')).pipe(Effect.provide(double.layer));

        expect(assessmentSummary(assessment)).toEqual({ cause: 'EVIDENCE_SCOPE_MISMATCH', kind: 'Indeterminate' });
      }),
  );
});

describe('#1396 Rule: two Auth identities with one address stay two subjects (pre-verification, AC-12)', () => {
  it.effect('Scenario: the second identity result is not applied to the first and no Party is created by address', () =>
    Effect.gen(function* sharedAddress() {
      // Privacy has a context only for the second occurrence; the first is located by its own occurrence record.
      const double = privacyGateDouble({
        'identity-one': () => Effect.succeed(eligibilityVerdictOf(deniedResponse('AUTHORITY_NOT_CURRENT'))),
        'identity-two': privacyAllowed,
      });
      const run = (recipientId: string) =>
        assessPrivacyEligibility(queryFor(recipientId)).pipe(Effect.provide(double.layer));

      expect(assessmentSummary(yield* run('identity-one'))).toEqual({
        cause: 'CONTEXT_NOT_SUPPORTED',
        kind: 'Indeterminate',
      });
      expect(assessmentSummary(yield* run('identity-two'))).toEqual({ kind: 'Allowed' });
      // Nothing that was asked carries an address: subjects are located by owner-qualified records only.
      expect(JSON.stringify(double.queries)).not.toContain('@');
    }),
  );
});

const candidateStatus = ({ recipient }: MessageIntentCandidate) =>
  RecipientDecision.$match(recipient, { Eligible: () => 'ELIGIBLE', Suppressed: ({ reason }) => reason });

const decisionWith = (answers: Readonly<Record<string, PrivacyAnswer>>) =>
  Effect.gen(function* decisionWithPrivacy() {
    const input = evaluationInput(type, [binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a', 'contact-a')]);
    const evaluated = yield* assessRecipients(input).pipe(Effect.provide(gateDouble({ 'contact-a': usable() }).layer));
    const assessment = yield* assessPrivacyEligibility(queryFor('recipient-a')).pipe(
      Effect.provide(privacyGateDouble(answers).layer),
    );
    const decision = decideOrThrow(
      fixtureRegistry(type),
      input.request,
      fixtureContext(
        evaluated.map(({ assessment: recipient }) =>
          recipientFactOf(recipient, input.request, privacyEvidenceOf(assessment)),
        ),
      ),
    );
    return CommunicationOutcome.$match(decision.outcome, {
      Candidates: ({ candidates }) => candidates.map(candidateStatus),
      NoMessage: () => ['NO_MESSAGE'],
    });
  });

describe('#1396 Rule: Privacy evidence feeds the Communication Decision without redesigning it', () => {
  it.effect('Scenario: only an evidenced ALLOWED makes the candidate eligible', () =>
    Effect.gen(function* onlyAllowed() {
      expect(yield* decisionWith({ 'recipient-a': privacyAllowed })).toEqual(['ELIGIBLE']);
    }),
  );

  it.effect.each([
    ['NOT_ALLOWED', privacyNotAllowed(), 'PRIVACY_NOT_ALLOWED'],
    ['INDETERMINATE', privacyIndeterminate, 'PRIVACY_INDETERMINATE'],
    ['an authorization failure', privacyUnavailable('AUTHORIZATION_DENIED'), 'PRIVACY_INDETERMINATE'],
    ['an owner outage', privacyUnavailable('OWNER_UNAVAILABLE'), 'PRIVACY_INDETERMINATE'],
    ['an ambiguous context', privacyUnavailable('CONTEXT_AMBIGUOUS'), 'PRIVACY_INDETERMINATE'],
  ] as const)(
    'Scenario: %s stops the candidate as %s and only a proven prohibition is NOT_ALLOWED',
    ([, answer, reason]) =>
      Effect.gen(function* stops() {
        expect(yield* decisionWith({ 'recipient-a': answer })).toEqual([reason]);
      }),
  );
});
