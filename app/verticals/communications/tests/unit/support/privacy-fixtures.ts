import { DateTime, Effect, Layer, Schema } from 'effect';

import {
  ProcessingEligibilityGate,
  ProcessingEligibilityVerdict,
} from '../../../src/domain/privacy/eligibility-gate.ts';
import type {
  EligibilityEvidence,
  ProcessingEligibilityQuery,
  ProcessingEligibilityVerdictCase,
} from '../../../src/domain/privacy/eligibility-gate.ts';
import { ProcessingEligibilityUnavailable } from '../../../src/domain/privacy/eligibility-errors.ts';
import type { UnavailableReason } from '../../../src/domain/privacy/eligibility-errors.ts';
import { ProcessingScopeSchema } from '../../../src/domain/privacy/processing-scope.ts';
import type { ProcessingScope } from '../../../src/domain/privacy/processing-scope.ts';
import { HandoffFact, ProviderFact, SourceCurrentness } from '../../../src/domain/privacy/suppression.ts';
import type { HandoffFactCase, ProviderFactCase } from '../../../src/domain/privacy/suppression.ts';
import type { MessageHandoffItem } from '../../../src/domain/privacy/handoff-decision.ts';
import type { RecipientEvaluationInput } from '../../../src/domain/recipient/assess-recipients.ts';
import type { OriginalRecipientBinding } from '../../../src/domain/recipient/original-binding.ts';
import { handoffPinOf } from '../../../src/domain/recipient/recheck-before-handoff.ts';
import { intentIdentity, TEST_GATE_CHECK_TIMEOUT } from './recipient-fixtures.ts';

/**
 * TEST-ONLY fixtures for the Privacy gate. Every controller, purpose, subject and verdict below is fictional. The
 * gate is a labelled test double: it proves how the domain REACTS to an owner answer, never that the real Privacy
 * owner answers so (that is proven against Privacy's real ledgers in `@app/privacy`), and no test using it is
 * delivery or production evidence.
 */

const decodeScope = Schema.decodeUnknownSync(ProcessingScopeSchema, { onExcessProperty: 'error' });

export const FIXTURE_PRIVACY_PURPOSE = 'fixture.privacy.purpose';
export const FIXTURE_MARKETING_PURPOSE = 'fixture.privacy.marketing';

interface ScopeOverrides {
  readonly catalogPurposeRef?: string;
  readonly channel?: string;
  readonly controllerRef?: string;
  readonly dataCategoryRefs?: readonly string[];
  readonly purposeRef?: string;
  readonly purposeVersionId?: string;
  readonly recipientRefs?: readonly string[];
  readonly subject?: unknown;
}

/** The exact Privacy scope of the fixture message to one recipient; the subject is located by an Auth-like source record. */
export const processingScope = (recipientId: string, overrides: ScopeOverrides = {}): ProcessingScope =>
  decodeScope({
    catalogPurposeRef: FIXTURE_PRIVACY_PURPOSE,
    channel: 'email',
    controllerRef: 'fixture-controller',
    dataCategoryRefs: ['fixture:contact'],
    operation: 'FIXTURE_SEND_MESSAGE',
    processingScopeRef: { scopeId: 'fixture-scope', scopeType: 'fixture.processing-scope' },
    purposeRef: 'fixture-purpose',
    purposeVersionId: 'fixture-purpose-version-1',
    recipientRefs: ['fixture.communications'],
    subject: {
      kind: 'SOURCE_ASSERTED',
      source: {
        issuer: 'fixture:auth',
        namespace: 'fixture-occurrences',
        occurrenceId: `fixture-occurrence:${recipientId}`,
        recordId: `fixture-record:${recipientId}`,
        recordType: 'fixture-verification',
        routeRef: 'fixture:route',
      },
    },
    ...overrides,
  });

export const FIXTURE_OWNER_DECISION_TIME = '2026-11-19T10:00:00.000Z';

/** Owner evidence that echoes the scope exactly as Privacy would for the evaluated use. */
export const ownerEvidence = (
  scope: ProcessingScope,
  outcome: 'ALLOWED' | 'INDETERMINATE' | 'NOT_ALLOWED',
  reasonCodes: readonly string[] = [`fixture_${outcome.toLowerCase()}`],
  decidedAt: string = FIXTURE_OWNER_DECISION_TIME,
): EligibilityEvidence => ({
  authoritativeReferences: [{ kind: 'FIXTURE_OWNER_FACT', reference: `fixture:${outcome}`, revision: '1' }],
  declaredScope: {
    basis: 'DECLARED_NOT_ECHOED',
    catalogPurposeRef: scope.catalogPurposeRef,
    channel: scope.channel,
    subject: scope.subject,
  },
  evaluatedScope: {
    controllerRef: scope.controllerRef,
    dataCategoryRefs: scope.dataCategoryRefs,
    operation: scope.operation,
    // Privacy echoes its own subject: the binding it made for a bound subject, an opaque reference otherwise
    privacySubjectRef: scope.subject.kind === 'PRIVACY_BINDING' ? scope.subject.bindingRef : 'fixture-privacy-subject',
    processingScopeRef: scope.processingScopeRef,
    purposeRef: scope.purposeRef,
    purposeVersionId: scope.purposeVersionId,
    recipientRefs: scope.recipientRefs,
  },
  policyRevisions: [{ policyRef: 'fixture:policy', revision: '1' }],
  reasonCodes,
  trustedDecisionTime: DateTime.makeUnsafe(decidedAt),
});

type OwnerReply = Effect.Effect<ProcessingEligibilityVerdictCase, ProcessingEligibilityUnavailable>;
export type PrivacyAnswer = (query: ProcessingEligibilityQuery) => OwnerReply;

export const privacyAllowed: PrivacyAnswer = ({ scope }) =>
  Effect.succeed(ProcessingEligibilityVerdict.Allowed({ evidence: ownerEvidence(scope, 'ALLOWED') }));

/** An ALLOWED the owner decided at its own time, so a test can tell a new owner evaluation from an old one. */
export const privacyAllowedAt =
  (decidedAt: string): PrivacyAnswer =>
  ({ scope }) =>
    Effect.succeed(
      ProcessingEligibilityVerdict.Allowed({ evidence: ownerEvidence(scope, 'ALLOWED', undefined, decidedAt) }),
    );

export const privacyIndeterminateAt =
  (decidedAt: string): PrivacyAnswer =>
  ({ scope }) =>
    Effect.succeed(
      ProcessingEligibilityVerdict.Indeterminate({
        cause: 'INPUTS_NOT_EVIDENCED',
        evidence: ownerEvidence(scope, 'INDETERMINATE', undefined, decidedAt),
      }),
    );

/** The owner answered with an already mapped verdict, for example from its public response. */
export const privacyVerdict =
  (verdict: ProcessingEligibilityVerdictCase): PrivacyAnswer =>
  () =>
    Effect.succeed(verdict);

export const privacyNotAllowed =
  (reasonCodes: readonly string[] = ['fixture_current_restriction']): PrivacyAnswer =>
  ({ scope }) =>
    Effect.succeed(
      ProcessingEligibilityVerdict.NotAllowed({
        basis: 'EVALUATED_PROHIBITION',
        evidence: ownerEvidence(scope, 'NOT_ALLOWED', reasonCodes),
      }),
    );

export const privacyIndeterminate: PrivacyAnswer = ({ scope }) =>
  Effect.succeed(
    ProcessingEligibilityVerdict.Indeterminate({
      cause: 'INPUTS_NOT_EVIDENCED',
      evidence: ownerEvidence(scope, 'INDETERMINATE'),
    }),
  );

export const privacyUnavailable =
  (reason: UnavailableReason): PrivacyAnswer =>
  () =>
    Effect.fail(new ProcessingEligibilityUnavailable({ reason }));

/** An owner that answers for ANOTHER use than the one asked about, for example a historical marketing ALLOWED. */
export const privacyAnswersFor =
  (other: (scope: ProcessingScope) => ProcessingScope, outcome: 'ALLOWED' | 'NOT_ALLOWED'): PrivacyAnswer =>
  ({ scope }) =>
    Effect.succeed(
      outcome === 'ALLOWED'
        ? ProcessingEligibilityVerdict.Allowed({ evidence: ownerEvidence(other(scope), 'ALLOWED') })
        : ProcessingEligibilityVerdict.NotAllowed({
            basis: 'EVALUATED_PROHIBITION',
            evidence: ownerEvidence(other(scope), 'NOT_ALLOWED'),
          }),
    );

export const privacyDying: PrivacyAnswer = () => Effect.die(new Error('fixture privacy adapter died'));
export const privacyThrowing: PrivacyAnswer = () => {
  throw new Error('fixture privacy adapter threw');
};
export const privacyHanging: PrivacyAnswer = () => Effect.never;

/**
 * TEST DOUBLE of the Privacy gate. It answers by the recipient id of the query, records EVERY query it receives (so a
 * test can prove that nothing was reused) and, like the real port, has no way to be told a cached answer. A recipient
 * it was not told about fails closed as an unavailable owner.
 */
export const privacyGateDouble = (answers: Readonly<Record<string, PrivacyAnswer>>) => {
  const queries: ProcessingEligibilityQuery[] = [];
  const layer = Layer.succeed(ProcessingEligibilityGate, {
    check: (query): OwnerReply => {
      queries.push(query);
      return (answers[query.recipient.recipientRef.resourceId] ?? privacyUnavailable('OWNER_UNAVAILABLE'))(query);
    },
    checkTimeout: TEST_GATE_CHECK_TIMEOUT,
  });
  return { layer, queries };
};

/** A message to decide again, exactly as its first decision pinned it. */
export const handoffItem = (
  input: RecipientEvaluationInput,
  binding: OriginalRecipientBinding,
  slotKey: string,
  overrides: {
    readonly handoff?: HandoffFactCase;
    readonly provider?: ProviderFactCase;
    readonly scope?: ProcessingScope;
  } = {},
): MessageHandoffItem => ({
  binding,
  handoff: overrides.handoff ?? HandoffFact.NotAttempted(),
  identity: intentIdentity(input, binding, slotKey),
  pin: handoffPinOf(input.type, binding),
  provider: overrides.provider ?? ProviderFact.Clear(),
  scope: overrides.scope ?? processingScope(binding.recipientRef.resourceId),
});

export const currentSource = SourceCurrentness.Current();
export const staleSource = (
  reason: 'SOURCE_NO_LONGER_VALID' | 'SOURCE_REVISION_NOT_CURRENT' | 'SOURCE_STATE_INELIGIBLE',
) => SourceCurrentness.Stale({ reason });
