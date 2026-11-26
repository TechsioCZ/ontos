import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { MessageTypeIdSchema, RecipientRoleSchema } from '../../src/domain/catalog/vocabulary.ts';
import { assessPrivacyEligibility, PrivacyAssessment } from '../../src/domain/privacy/assess-privacy.ts';
import type { PrivacySourceEligibilityResponseSchema } from '../../src/domain/privacy/source-eligibility-response.ts';
import { ProcessingEligibilityGate, ProcessingEligibilityVerdict } from '../../src/domain/privacy/eligibility-gate.ts';
import type { ProcessingEligibilityQuery } from '../../src/domain/privacy/eligibility-gate.ts';
import { actionOwnerCall, underOwnerCall } from '../../src/integrations/owner-call.ts';
import {
  privacyProcessingEligibilityGateOver,
  privacyQuestionOf,
} from '../../src/integrations/privacy-eligibility-gate.ts';
import type { PrivacyOwnerTransport } from '../../src/integrations/privacy-eligibility-gate.ts';
import { fixtureRequest } from './support/catalog-fixtures.ts';
import { processingScope } from './support/privacy-fixtures.ts';
import { binding, TEST_GATE_CHECK_TIMEOUT } from './support/recipient-fixtures.ts';

/**
 * #1406 D.8 — a subject Privacy bound before the address was verified is asked through Privacy's pre-verification Read,
 * and its answer is read exactly like every other Privacy answer. The transport here is SCRIPTED (it proves how the
 * adapter asks and reads, not that Privacy answers so); the real Privacy contract answers in
 * `scripts/integration/auth-communications-privacy-blocked.test.mts` and in `@app/privacy`'s PostgreSQL suite.
 */
const BINDING = '30000000-0000-4000-8000-0000000000b1';
const boundScope = processingScope('customer-1', { subject: { bindingRef: BINDING, kind: 'PRIVACY_BINDING' } });

const queryOf = (scope: ProcessingEligibilityQuery['scope']): ProcessingEligibilityQuery => ({
  occurrence: fixtureRequest().occurrence,
  recipient: {
    recipientRef: binding('original-recipient', 'customer-1').recipientRef,
    role: RecipientRoleSchema.make('original-recipient'),
  },
  scope,
  sourceModule: fixtureRequest().source.moduleKey,
  tenantId: fixtureRequest().tenantId,
  typeId: MessageTypeIdSchema.make('fixture.single-message'),
});

const ownerCall = actionOwnerCall({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '30000000-0000-4000-8000-000000000004',
    authContextRef: 'fixture:pre-verification-gate',
    authenticationNamespaceId: 'core.staff',
    authMethod: 'session',
    principalId: '30000000-0000-4000-8000-000000000003',
    tenantId: fixtureRequest().tenantId,
  }),
  correlationId: 'fixture:pre-verification-gate',
});

/** Privacy's evidence ON THE WIRE for the bound scope, with its own subject reference set to `subjectRef`. */
const evidenceFor = (outcome: 'ALLOWED' | 'INDETERMINATE' | 'NOT_ALLOWED', subjectRef = BINDING) => ({
  authoritativeReferences: [{ kind: 'fixture.binding', reference: subjectRef, revision: '1' }],
  evaluatedScope: {
    controllerRef: boundScope.controllerRef,
    dataCategoryRefs: boundScope.dataCategoryRefs,
    operation: boundScope.operation,
    processingScopeRef: boundScope.processingScopeRef,
    purposeRef: boundScope.purposeRef,
    purposeVersionId: boundScope.purposeVersionId,
    recipientRefs: boundScope.recipientRefs,
    subjectRef: { resourceId: subjectRef },
  },
  outcome,
  policyRevisions: [{ policyRef: 'fixture:policy', revision: '1' }],
  reasonCodes: [`fixture_${outcome.toLowerCase()}`],
  trustedDecisionTime: '2026-11-19T10:00:00.000Z',
});

type OwnerAnswer = typeof PrivacySourceEligibilityResponseSchema.Encoded;
const AT = '2026-11-19T10:00:01.000Z';

const checkWith = (transport: PrivacyOwnerTransport, scope = boundScope) =>
  Effect.gen(function* check() {
    const gate = yield* ProcessingEligibilityGate;
    return yield* gate.check(queryOf(scope));
  }).pipe(Effect.provide(privacyProcessingEligibilityGateOver({ checkTimeout: TEST_GATE_CHECK_TIMEOUT }, transport)));

const answering =
  (answer: OwnerAnswer): PrivacyOwnerTransport =>
  () =>
    Effect.succeed(answer);

const failingWith =
  (status: number): PrivacyOwnerTransport =>
  () =>
    Effect.fail({ status });

/** The verdict for one owner answer, asked under an operation in progress. */
const verdictFor = (answer: OwnerAnswer) => checkWith(answering(answer)).pipe(underOwnerCall(ownerCall));

describe('#1406 D.8 the question asked for a subject Privacy bound before verification', () => {
  it.effect('asks the pre-verification Read by binding, catalog purpose and activity, and nothing else', () =>
    Effect.gen(function* asked() {
      const question = yield* privacyQuestionOf(queryOf(boundScope));
      expect(question.kind).toBe('PRE_VERIFICATION');
      expect(question.declarationKey).toBe('privacy.core.pre-verification-eligibility.read');
      expect(question.request).toEqual({
        bindingRef: BINDING,
        consumerModuleId: 'communications.core',
        operation: 'FIXTURE_SEND_MESSAGE',
        sourcePurposeRef: boundScope.catalogPurposeRef,
      });
    }),
  );

  it.effect('keeps every other locator on the source-processing Read', () =>
    Effect.gen(function* source() {
      const question = yield* privacyQuestionOf(queryOf(processingScope('customer-1')));
      expect(question.kind).toBe('SOURCE_PROCESSING');
      expect(question.declarationKey).toBe('privacy.core.source-processing-eligibility.read');
    }),
  );
});

describe('#1406 D.8 the answer for a bound subject keeps three outcomes and every failure apart', () => {
  it.effect('reads ALLOWED, NOT_ALLOWED and INDETERMINATE only from the owner evidence', () =>
    Effect.gen(function* outcomes() {
      const allowed = yield* verdictFor({ evaluatedAt: AT, evidence: evidenceFor('ALLOWED'), outcome: 'ALLOWED' });
      expect(ProcessingEligibilityVerdict.$is('Allowed')(allowed)).toBe(true);
      const notAllowed = yield* verdictFor({
        eligibility: { evidence: evidenceFor('NOT_ALLOWED'), outcome: 'NOT_ALLOWED' },
        evaluatedAt: AT,
        outcome: 'DENIED',
        reason: 'PROCESSING_NOT_ALLOWED',
      });
      expect(ProcessingEligibilityVerdict.$is('NotAllowed')(notAllowed) && notAllowed.basis).toBe(
        'EVALUATED_PROHIBITION',
      );
      const indeterminate = yield* verdictFor({
        eligibility: { evidence: evidenceFor('INDETERMINATE'), outcome: 'INDETERMINATE' },
        evaluatedAt: AT,
        outcome: 'DENIED',
        reason: 'PROCESSING_NOT_ALLOWED',
      });
      expect(ProcessingEligibilityVerdict.$is('Indeterminate')(indeterminate) && indeterminate.cause).toBe(
        'INPUTS_NOT_EVIDENCED',
      );
      const unknownBinding = yield* verdictFor({
        eligibility: { outcome: 'NOT_EVALUATED', reasonCode: 'SUBJECT_NOT_FOUND' },
        evaluatedAt: AT,
        outcome: 'DENIED',
        reason: 'AUTHORITY_NOT_CURRENT',
      });
      expect(unknownBinding).toEqual(ProcessingEligibilityVerdict.Indeterminate({ cause: 'CONTEXT_NOT_SUPPORTED' }));
    }),
  );

  it.effect('never turns an outage, a denied call or a missing authority into a Privacy outcome', () =>
    Effect.gen(function* failures() {
      const forbidden = yield* Effect.flip(checkWith(failingWith(403)).pipe(underOwnerCall(ownerCall)));
      expect(forbidden.reason).toBe('AUTHORIZATION_DENIED');
      const outage = yield* Effect.flip(checkWith(failingWith(503)).pipe(underOwnerCall(ownerCall)));
      expect(outage.reason).toBe('OWNER_UNAVAILABLE');
      // an answer that is not the published shape is no decision at all
      const garbage = yield* Effect.flip(
        checkWith(() => Effect.succeed({ outcome: 'ALLOWED' })).pipe(underOwnerCall(ownerCall)),
      );
      expect(garbage.reason).toBe('OWNER_UNAVAILABLE');
      // with no operation in progress there is no authority to ask under, so Privacy is never asked
      const asked: unknown[] = [];
      const noCall = yield* Effect.flip(
        checkWith((question) => {
          asked.push(question);
          return Effect.succeed({});
        }),
      );
      expect(noCall.reason).toBe('AUTHORIZATION_DENIED');
      expect(asked).toEqual([]);
    }),
  );

  it.effect('refuses an ALLOWED whose Privacy subject is not the binding that was asked about', () =>
    Effect.gen(function* foreignSubject() {
      const assessed = yield* assessPrivacyEligibility(queryOf(boundScope)).pipe(
        underOwnerCall(ownerCall),
        Effect.provide(
          privacyProcessingEligibilityGateOver(
            { checkTimeout: TEST_GATE_CHECK_TIMEOUT },
            answering({
              evaluatedAt: AT,
              evidence: evidenceFor('ALLOWED', '30000000-0000-4000-8000-0000000000ff'),
              outcome: 'ALLOWED',
            }),
          ),
        ),
      );
      expect(PrivacyAssessment.$is('Indeterminate')(assessed) && assessed.cause).toBe('EVIDENCE_SCOPE_MISMATCH');
    }),
  );
});
