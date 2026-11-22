import { Data, DateTime, Effect, Exit, identity, Option } from 'effect';

import type { PrivacyEvidence } from '../catalog/vocabulary.ts';
import { ProcessingEligibilityGate, ProcessingEligibilityVerdict } from './eligibility-gate.ts';
import type {
  EligibilityEvidence,
  IndeterminateCause,
  NotAllowedBasis,
  ProcessingEligibilityQuery,
  ProcessingEligibilityVerdictCase,
  UnavailableReason,
} from './eligibility-gate.ts';
import { safeCauseSummaryOf } from '../intake/safe-cause.ts';
import { processingScopeKey, subjectLocatorKey } from './processing-scope.ts';
import type { ProcessingScope } from './processing-scope.ts';

/**
 * What Communications concludes from one Privacy answer for ONE exact scope (#1396, BR-01, BR-03, BR-04). Four
 * outcomes, none of them convertible into another:
 * - `Allowed`: the owner evidenced a Current ALLOWED for the scope it ECHOED (controller, activity, processing scope,
 *   purpose version, data and recipients); the channel, catalog purpose and subject locator are only DECLARED by the
 *   adapter and not echoed by Privacy (`DECLARED_NOT_ECHOED`). It permits only to CONTINUE into the
 *   independent recipient, source and channel checks; it is not Permission, not a send and not a delivery.
 * - `NotAllowed`: the owner PROVED a prohibition of this scope, with its own evidence.
 * - `Indeterminate`: the owner answered but could not evidence a decision; no prohibition is proven.
 * - `Unavailable`: no decision was reached (denied access, owner outage, ambiguous context). It is not an owner decision.
 * `Allowed` carries the key of the scope it answered, so it can never be applied to another purpose, controller, subject
 * or channel, and nothing here expires or renews: a later handoff asks Privacy again.
 */
export type PrivacyAssessmentCase = Data.TaggedEnum<{
  Allowed: { readonly assessedAt: DateTime.Utc; readonly evidence: EligibilityEvidence; readonly scopeKey: string };
  Indeterminate: {
    readonly assessedAt: DateTime.Utc;
    readonly cause: IndeterminateCause;
    readonly evidence?: EligibilityEvidence;
    readonly scopeKey: string;
  };
  NotAllowed: {
    readonly assessedAt: DateTime.Utc;
    readonly basis: NotAllowedBasis;
    readonly evidence?: EligibilityEvidence;
    readonly scopeKey: string;
  };
  Unavailable: { readonly assessedAt: DateTime.Utc; readonly reason: UnavailableReason; readonly scopeKey: string };
}>;
export const PrivacyAssessment = Data.taggedEnum<PrivacyAssessmentCase>();

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === a.length && right.size === b.length && left.size === right.size && a.every((x) => right.has(x));
};

/**
 * The decision is for exactly the use that was asked about, in the two ways the evidence can say so, kept apart:
 * - ECHOED by Privacy (`evaluatedScope`): controller, activity, processing scope, purpose and its version, data and
 *   recipient dimensions. Only these are verified against the owner's own answer;
 * - DECLARED by the adapter, NOT echoed (`declaredScope`): the subject locator, the catalog purpose and the channel.
 *   Privacy's published scope has none of them, so ALLOWED proves nothing about them; they are only the adapter's request
 *   binding, compared so that an answer an adapter correlated with another message, subject, purpose or channel is refused.
 * A decision for another scope is never applied, in either direction.
 */
/**
 * A subject Privacy itself bound is the one locator Privacy CAN echo: its own subject reference must be that binding.
 * The other locators carry no Privacy identity, so for them only the declared binding below is compared.
 */
const subjectEchoMatches = (scope: ProcessingScope, privacySubjectRef: string) =>
  scope.subject.kind !== 'PRIVACY_BINDING' || scope.subject.bindingRef === privacySubjectRef;

const evidenceCoversScope = (evidence: EligibilityEvidence, scope: ProcessingScope) => {
  const echoed = evidence.evaluatedScope;
  const declared = evidence.declaredScope;
  return (
    echoed.controllerRef === scope.controllerRef &&
    echoed.operation === scope.operation &&
    echoed.purposeRef === scope.purposeRef &&
    echoed.purposeVersionId === scope.purposeVersionId &&
    echoed.processingScopeRef.scopeId === scope.processingScopeRef.scopeId &&
    echoed.processingScopeRef.scopeType === scope.processingScopeRef.scopeType &&
    sameSet(echoed.dataCategoryRefs, scope.dataCategoryRefs) &&
    sameSet(echoed.recipientRefs, scope.recipientRefs) &&
    subjectEchoMatches(scope, echoed.privacySubjectRef) &&
    subjectLocatorKey(declared.subject) === subjectLocatorKey(scope.subject) &&
    declared.catalogPurposeRef === scope.catalogPurposeRef &&
    declared.channel === scope.channel
  );
};

const assessmentOf = (
  verdict: ProcessingEligibilityVerdictCase,
  query: ProcessingEligibilityQuery,
  assessedAt: DateTime.Utc,
): PrivacyAssessmentCase => {
  const scopeKey = processingScopeKey(query.scope);
  const indeterminate = (cause: IndeterminateCause, evidence?: EligibilityEvidence) =>
    evidence === undefined
      ? PrivacyAssessment.Indeterminate({ assessedAt, cause, scopeKey })
      : PrivacyAssessment.Indeterminate({ assessedAt, cause, evidence, scopeKey });
  return ProcessingEligibilityVerdict.$match(verdict, {
    Allowed: ({ evidence }) =>
      evidenceCoversScope(evidence, query.scope)
        ? PrivacyAssessment.Allowed({ assessedAt, evidence, scopeKey })
        : indeterminate('EVIDENCE_SCOPE_MISMATCH', evidence),
    Indeterminate: ({ cause, evidence }) => indeterminate(cause, evidence),
    NotAllowed: ({ basis, evidence }) => {
      // A proven prohibition needs the owner's evidence for exactly this scope; without it nothing is proven.
      if (evidence === undefined) {
        return indeterminate('EVIDENCE_MISSING');
      }
      return evidenceCoversScope(evidence, query.scope)
        ? PrivacyAssessment.NotAllowed({ assessedAt, basis, evidence, scopeKey })
        : indeterminate('EVIDENCE_SCOPE_MISMATCH', evidence);
    },
  });
};

/**
 * Ask Privacy about one exact scope and conclude. Never fails and never allows by default: a gate that is
 * unavailable, throws, dies or does not answer within its deadline is `Unavailable` for THIS question only.
 */
export const assessPrivacyEligibility = Effect.fn('Communications.assessPrivacyEligibility')(function* assess(
  query: ProcessingEligibilityQuery,
) {
  const gate = yield* Effect.service(ProcessingEligibilityGate);
  const assessedAt = yield* DateTime.now;
  const scopeKey = processingScopeKey(query.scope);
  const unavailable = (reason: UnavailableReason) => PrivacyAssessment.Unavailable({ assessedAt, reason, scopeKey });
  return yield* Effect.suspend(() => gate.check(query)).pipe(
    Effect.map((verdict) => assessmentOf(verdict, query, assessedAt)),
    Effect.catchTag('ProcessingEligibilityUnavailable', ({ reason }) => Effect.succeed(unavailable(reason))),
    Effect.timeoutOption(gate.checkTimeout),
    Effect.map(Option.getOrElse(() => unavailable('OWNER_UNAVAILABLE'))),
    // A defective adapter is logged by its safe kind only (never its raw cause), kept out of this result and treated as an unavailable owner.
    Effect.tapCause((cause) =>
      Effect.logError('Privacy eligibility check failed unexpectedly; failing closed', safeCauseSummaryOf(cause)),
    ),
    Effect.exit,
    Effect.map(Exit.match({ onFailure: () => unavailable('OWNER_UNAVAILABLE'), onSuccess: identity })),
  );
});

/**
 * The positive evidence the Communication Decision (d21-02) takes. Only an evidenced ALLOWED is `ALLOWED`; a proven
 * prohibition is `NOT_ALLOWED`; everything else, including a failure to reach any decision, is `INDETERMINATE` and
 * therefore stops the message without ever being reported as a prohibition.
 */
export const privacyEvidenceOf = (assessment: PrivacyAssessmentCase): PrivacyEvidence =>
  PrivacyAssessment.$match(assessment, {
    Allowed: (): PrivacyEvidence => 'ALLOWED',
    Indeterminate: (): PrivacyEvidence => 'INDETERMINATE',
    NotAllowed: (): PrivacyEvidence => 'NOT_ALLOWED',
    Unavailable: (): PrivacyEvidence => 'INDETERMINATE',
  });

/** Whether a retained assessment covers this exact question. It never does for any other scope, and never for time. */
export const assessmentCoversScope = (assessment: PrivacyAssessmentCase, scope: ProcessingScope) =>
  assessment.scopeKey === processingScopeKey(scope);
