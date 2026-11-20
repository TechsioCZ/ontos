import { DateTime, Match, Schema } from 'effect';
import { PrivacyOwnerScopeSchema } from '@app/shared-contracts';
import type {
  PrivacyMeasureEncoded,
  PrivacyOwnerCoverageResultEncoded,
  PrivacyOwnerExecutionOutcomeEncoded,
  PrivacyOwnerScopeEncoded,
} from '@app/shared-contracts';

import { COMMUNICATIONS_OWNER_CAPABILITY, INPUT_OWNER } from './inventory.ts';
import type { GateOwner } from './inventory.ts';

/**
 * Communications' truthful answer to an approved Privacy Measure (#600-#602, D21 PRIV-COM-07/12/17).
 *
 * This module only EVALUATES. It performs no mutation of any kind and there is no DELETE, ANONYMIZE or PURGE Action in
 * Communications. Receiving a measure is not executing it: the only way an exact scope reaches ACHIEVED or PARTIAL is an
 * authoritative record of a SEPARATELY executed, human-confirmed owner Action for exactly this owner, tenant, scope,
 * measure and source decision revision (`OwnerExecutionEvidenceRecord`). Evidence for anything else is ignored and named,
 * never counted. The record's writer is a future, separately approved owner Action: it is deliberately not part of D21.
 */

/** The result an authorized human's owner Action reported for ONE target content reference. */
export const EvidencedTargetResultSchema = Schema.Literals([
  'ANONYMIZED',
  /** The Action failed and the owner PROVED that it changed nothing: a definite, retryable technical failure. */
  'FAILED_BEFORE_ANY_MUTATION',
  /** The Action failed and the owner cannot prove it changed nothing: reconciliation first, never a retry. */
  'FAILED_AFTER_POSSIBLE_MUTATION',
  'NOT_EXECUTED',
  'RECTIFIED',
  'REMOVED',
  'RESTRICTED',
]);
export type EvidencedTargetResult = typeof EvidencedTargetResultSchema.Type;

/**
 * - `RECEIVED`: the owner took the handed-over measure over and NOTHING has started (it carries no target result).
 * - `IN_PROGRESS`: a human-confirmed owner Action is running. It never counts a target as achieved.
 * - `COMPLETED`: the Action ended; only its results can reach ACHIEVED or PARTIAL.
 */
export const OwnerExecutionPhaseSchema = Schema.Literals(['COMPLETED', 'IN_PROGRESS', 'RECEIVED']);
export type OwnerExecutionPhase = typeof OwnerExecutionPhaseSchema.Type;

/**
 * One confirmed result for one target. `reconcilesEvidenceRef` is the explicit reconciliation fact: it names the EARLIER evidence
 * record whose FAILED_AFTER_POSSIBLE_MUTATION result for the same target the human has since resolved with this (different)
 * result. Without it, a possible mutation stays unresolved however many later results follow.
 */
export interface EvidencedTargetEntry {
  readonly contentRef: string;
  readonly reconcilesEvidenceRef?: string;
  readonly result: EvidencedTargetResult;
}

export interface OwnerExecutionEvidenceRecord {
  readonly confirmedAt: DateTime.Utc;
  /** The authorized human who separately confirmed THIS exact owner Action. Their identity is a reference only. */
  readonly confirmedByHumanRef: string;
  readonly evidenceRef: string;
  readonly measureRef: string;
  readonly phase: OwnerExecutionPhase;
  readonly results: readonly EvidencedTargetEntry[];
  /**
   * The EXACT owner scope the Action ran for: owner, tenant, controller, subject, requested scope, scope parts and trusted
   * lookups. Evidence for another subject, controller or lookup is never evidence for this measure.
   */
  readonly scope: PrivacyOwnerScopeEncoded;
  readonly sourceDecisionRef: string;
  readonly sourceDecisionRevision: string;
}

export interface OwnerMeasureBlocker {
  readonly blockerRef: string;
  readonly contentRefs: readonly string[];
  readonly kind: 'LEGAL_HOLD' | 'RETENTION_OBLIGATION';
}

/**
 * Privacy's explicit statement of blocker applicability for one measure: who assessed it and what it found. An empty list is
 * "no blocker assessed by `assessedByRef`". Communications has no hold source of its own, so it never invents either.
 */
export interface OwnerBlockerAssessment {
  readonly assessedByRef: string;
  readonly blockers: readonly OwnerMeasureBlocker[];
}

export interface OwnerMeasureEvaluationInput {
  /** Absent means NOT ASSESSED, which is never read as "no blocker": an unassessed measure can never be ACHIEVED. */
  readonly blockerAssessment?: OwnerBlockerAssessment | undefined;
  readonly confirmedAt: PrivacyOwnerExecutionOutcomeEncoded['confirmedAt'];
  readonly coverage: PrivacyOwnerCoverageResultEncoded;
  readonly evidence: readonly OwnerExecutionEvidenceRecord[];
  readonly evidenceRefs: readonly string[];
  readonly measure: PrivacyMeasureEncoded;
  readonly outcomeRef: string;
  /** The measure as first delivered under the same idempotency key, when this is a retry. */
  readonly previousMeasure?: PrivacyMeasureEncoded;
}

const canonical = (references: readonly string[]): readonly string[] => [...references].toSorted();
const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const a = canonical(left);
  const b = canonical(right);
  return a.length === b.length && a.every((reference, index) => reference === b[index]);
};

const subjectKey = (subject: PrivacyMeasureEncoded['scope']['subject']): string =>
  Match.value(subject).pipe(
    Match.tag('RESOLVED_DATA_SUBJECT', ({ subjectRef }) => `S:${subjectRef}`),
    Match.tag('ANONYMOUS_PRIVACY_CONTEXT', ({ contextRef }) => `A:${contextRef}`),
    Match.exhaustive,
  );

/** Exact owner-scope equality; reference lists compare as sets because their order carries no meaning. */
export const isSameOwnerScope = (
  left: PrivacyMeasureEncoded['scope'],
  right: PrivacyMeasureEncoded['scope'],
): boolean =>
  left.controllerRef === right.controllerRef &&
  (left.dsrControllerObligationRef ?? '') === (right.dsrControllerObligationRef ?? '') &&
  left.ownerCapability === right.ownerCapability &&
  left.requestedScopeRef === right.requestedScopeRef &&
  left.tenantId === right.tenantId &&
  subjectKey(left.subject) === subjectKey(right.subject) &&
  sameSet(left.requestedScopePartRefs, right.requestedScopePartRefs) &&
  sameSet(left.trustedLookupRefs, right.trustedLookupRefs);

/** Measure identity: a retry of the same Privacy Measure must carry exactly this meaning. */
export const isSameMeasureIdentity = (left: PrivacyMeasureEncoded, right: PrivacyMeasureEncoded): boolean =>
  left.idempotencyKey === right.idempotencyKey &&
  left.intendedOutcome === right.intendedOutcome &&
  left.measureRef === right.measureRef &&
  left.requestedAt === right.requestedAt &&
  left.sourceDecisionRef === right.sourceDecisionRef &&
  left.sourceDecisionRevision === right.sourceDecisionRevision &&
  isSameOwnerScope(left.scope, right.scope) &&
  sameSet(left.expectedEvidenceRefs, right.expectedEvidenceRefs) &&
  sameSet(left.preconditionRefs, right.preconditionRefs) &&
  sameSet(left.targetContentRefs, right.targetContentRefs);

/** The repository's opaque Privacy reference (non-blank, trimmed, bounded): the same schema the measure's references use. */
const isOpaquePrivacyReference = Schema.is(PrivacyOwnerScopeSchema.fields.controllerRef);

/**
 * Evidence counts only when a human confirmed it (a well-formed, non-blank reference) and it names exactly this owner,
 * tenant, controller, subject, requested scope and lookups, measure and source decision revision.
 */
export const evidenceBelongsToMeasure = (
  record: OwnerExecutionEvidenceRecord,
  measure: PrivacyMeasureEncoded,
): boolean =>
  isOpaquePrivacyReference(record.confirmedByHumanRef) &&
  isOpaquePrivacyReference(record.evidenceRef) &&
  record.scope.ownerCapability === COMMUNICATIONS_OWNER_CAPABILITY &&
  measure.scope.ownerCapability === COMMUNICATIONS_OWNER_CAPABILITY &&
  isSameOwnerScope(record.scope, measure.scope) &&
  record.measureRef === measure.measureRef &&
  record.sourceDecisionRef === measure.sourceDecisionRef &&
  record.sourceDecisionRevision === measure.sourceDecisionRevision;

const achievedFor = {
  ANONYMIZE: ['ANONYMIZED'],
  DELETE: ['REMOVED'],
  ENFORCE_DISPOSITION_RESTRICTION: ['RESTRICTED'],
  ENFORCE_PROCESSING_RESTRICTION: ['RESTRICTED'],
  RECTIFY: ['RECTIFIED'],
} as const satisfies Record<PrivacyMeasureEncoded['intendedOutcome'], readonly EvidencedTargetResult[]>;

type OutcomeStatus = PrivacyOwnerExecutionOutcomeEncoded['status'];

const outcomeOf = (
  input: OwnerMeasureEvaluationInput,
  status: OutcomeStatus,
  reason: string,
  partition: { readonly affected: readonly string[]; readonly remaining: readonly string[] },
  evidenceRefs: readonly string[] = input.evidenceRefs,
): PrivacyOwnerExecutionOutcomeEncoded => ({
  affectedContentRefs: [...partition.affected],
  confirmedAt: input.confirmedAt,
  evidenceRefs: [...evidenceRefs],
  measureRef: input.measure.measureRef,
  outcomeRef: input.outcomeRef,
  reason,
  reconciliationRequired: status === 'INDETERMINATE',
  remainingContentRefs: [...partition.remaining],
  scope: input.measure.scope,
  sourceDecisionRef: input.measure.sourceDecisionRef,
  sourceDecisionRevision: input.measure.sourceDecisionRevision,
  status,
});

const untouched = (measure: PrivacyMeasureEncoded) => ({ affected: [], remaining: [...measure.targetContentRefs] });

const byConfirmation = (left: OwnerExecutionEvidenceRecord, right: OwnerExecutionEvidenceRecord): number =>
  DateTime.toEpochMillis(left.confirmedAt) - DateTime.toEpochMillis(right.confirmedAt);

/** The latest result reported per exact target by the given (already scope-bound, human-confirmed) records. */
const latestResults = (
  records: readonly OwnerExecutionEvidenceRecord[],
): ReadonlyMap<string, EvidencedTargetResult> => {
  const latest = new Map<string, EvidencedTargetResult>();
  for (const record of records.toSorted(byConfirmation)) {
    for (const { contentRef, result } of record.results) {
      latest.set(contentRef, result);
    }
  }
  return latest;
};

/**
 * A possible-mutation failure is resolved only by an explicit reconciliation fact: a LATER, COMPLETED record whose result for the
 * same target names this very failure (`reconcilesEvidenceRef`) and settles it with a result other than another possible
 * mutation. A later result that merely follows it, however definite it looks, resolves nothing.
 */
const isReconciled = (
  records: readonly OwnerExecutionEvidenceRecord[],
  failed: OwnerExecutionEvidenceRecord,
  contentRef: string,
): boolean =>
  records.some(
    (later) =>
      later !== failed &&
      later.phase === 'COMPLETED' &&
      byConfirmation(failed, later) <= 0 &&
      later.results.some(
        (entry) =>
          entry.contentRef === contentRef &&
          entry.reconcilesEvidenceRef === failed.evidenceRef &&
          entry.result !== 'FAILED_AFTER_POSSIBLE_MUTATION',
      ),
  );

const hasUnresolvedPossibleMutation = (records: readonly OwnerExecutionEvidenceRecord[], contentRef: string): boolean =>
  records.some(
    (record) =>
      record.results.some(
        ({ contentRef: ref, result }) => ref === contentRef && result === 'FAILED_AFTER_POSSIBLE_MUTATION',
      ) && !isReconciled(records, record, contentRef),
  );

/**
 * Partitions the exact targets by what matching, human-confirmed evidence reports for each of them. ONLY the results of a
 * COMPLETED Action can make a target achieved: a result inside an IN_PROGRESS or RECEIVED record never counts, even when it
 * sits next to a COMPLETED one. A failure that may have mutated is read from every record, whatever its phase, and stays
 * unresolved until an explicit reconciliation fact settles it: a possible mutation is never ignored and never erased by a
 * later result.
 */
const partitionByEvidence = (measure: PrivacyMeasureEncoded, evidence: readonly OwnerExecutionEvidenceRecord[]) => {
  const accepted = new Set<EvidencedTargetResult>(achievedFor[measure.intendedOutcome]);
  const completed = latestResults(evidence.filter(({ phase }) => phase === 'COMPLETED'));
  const affected = measure.targetContentRefs.filter((ref) => {
    const result = completed.get(ref);
    return result !== undefined && accepted.has(result);
  });
  const affectedSet = new Set(affected);
  return {
    affected,
    failedWithoutMutation: measure.targetContentRefs.filter(
      (ref) => completed.get(ref) === 'FAILED_BEFORE_ANY_MUTATION',
    ),
    remaining: measure.targetContentRefs.filter((ref) => !affectedSet.has(ref)),
    uncertain: measure.targetContentRefs.filter((ref) => hasUnresolvedPossibleMutation(evidence, ref)),
  };
};

const currentlyFoundRefs = (coverage: PrivacyOwnerCoverageResultEncoded): ReadonlySet<string> =>
  new Set(coverage.coverageParts.flatMap(({ foundContentRefs }) => foundContentRefs));

const heldRefsOf = (assessment: OwnerBlockerAssessment | undefined): ReadonlySet<string> =>
  new Set((assessment?.blockers ?? []).flatMap(({ contentRefs }) => contentRefs));

/**
 * A claimed result must be consistent with what the owner CURRENTLY holds, for every operation:
 * - DELETE and ANONYMIZE take the data away from the data subject's exact-reference lookup (identifiability removed is the point
 *   of ANONYMIZE), so a claimed target that the lookup still FINDS is a contradiction that only reconciliation settles.
 * - RECTIFY and RESTRICT keep the data, so a claimed target the owner does not hold cannot be achieved: absence from complete
 *   coverage contradicts the claim, and absence from incomplete coverage proves nothing either way.
 * Communications' own tables carry no signal of a rectification or a restriction, so for those two the confirmed result of the
 * human-confirmed owner Action (#600) is the evidence once the owner holds the target and Privacy assessed the blockers.
 */
const contradictionOf = (
  outcome: PrivacyMeasureEncoded['intendedOutcome'],
  affected: readonly string[],
  coverage: PrivacyOwnerCoverageResultEncoded,
): string | undefined => {
  const found = currentlyFoundRefs(coverage);
  if (outcome === 'DELETE') {
    return affected.some((ref) => found.has(ref)) ? 'CLAIMED_REMOVAL_CONTRADICTED_BY_CURRENT_COVERAGE' : undefined;
  }
  if (outcome === 'ANONYMIZE') {
    return affected.some((ref) => found.has(ref))
      ? 'CLAIMED_ANONYMIZATION_CONTRADICTED_BY_CURRENT_COVERAGE'
      : undefined;
  }
  if (affected.every((ref) => found.has(ref))) {
    return undefined;
  }
  return coverage.coverageStatus === 'COMPLETE'
    ? 'CLAIMED_RESULT_TARGET_NOT_HELD_BY_OWNER'
    : 'COMMUNICATIONS_OWNER_SCOPE_COVERAGE_INCOMPLETE';
};

const evaluateWithEvidence = (
  input: OwnerMeasureEvaluationInput,
  matching: readonly OwnerExecutionEvidenceRecord[],
): PrivacyOwnerExecutionOutcomeEncoded => {
  const { measure } = input;
  const partition = partitionByEvidence(measure, matching);
  const evidenceRefs = [...new Set([...input.evidenceRefs, ...matching.map(({ evidenceRef }) => evidenceRef)])];
  const conclude = (
    status: OutcomeStatus,
    reason: string,
    affected = partition.affected,
    remaining = partition.remaining,
  ) => outcomeOf(input, status, reason, { affected, remaining }, evidenceRefs);
  if (partition.uncertain.length > 0) {
    // A failure after a possible mutation is never retried or settled by a guess: the owner reconciles first.
    return conclude('INDETERMINATE', 'OWNER_ACTION_FAILED_AFTER_POSSIBLE_MUTATION');
  }
  const { blockerAssessment } = input;
  const held = heldRefsOf(blockerAssessment);
  if (partition.affected.length === 0 && measure.targetContentRefs.some((ref) => held.has(ref))) {
    // The same current blocker that stops the evidence-free answer stops a measure whose Action has settled nothing.
    return conclude('BLOCKED', 'LEGAL_HOLD_OR_RETENTION_OBLIGATION_IS_CURRENT', [], [...measure.targetContentRefs]);
  }
  const [latest] = matching.toSorted((left, right) => byConfirmation(right, left));
  // The Action's own latest word wins while it has not ended: a started Action is IN_PROGRESS, a taken-over one RECEIVED.
  if (latest?.phase === 'IN_PROGRESS' && partition.remaining.length > 0) {
    return conclude('IN_PROGRESS', 'OWNER_ACTION_IN_PROGRESS_CONFIRMED_BY_HUMAN');
  }
  if (latest?.phase === 'RECEIVED' && partition.affected.length === 0) {
    return conclude('RECEIVED', 'MEASURE_RECEIVED_BY_OWNER_NOTHING_STARTED');
  }
  let { affected, remaining } = partition;
  // What the evidence says must be consistent with what the owner currently holds, exactly as the evidence-free answer is.
  const contradiction = contradictionOf(measure.intendedOutcome, affected, input.coverage);
  if (contradiction !== undefined) {
    return conclude('INDETERMINATE', contradiction);
  }
  if (affected.length > 0 && blockerAssessment === undefined) {
    // Blocker applicability was never assessed by Privacy: no target counts as achieved, whatever a human confirmed.
    return conclude('BLOCKED', 'HOLD_APPLICABILITY_NOT_ASSESSED', [], [...measure.targetContentRefs]);
  }
  if (affected.some((ref) => held.has(ref))) {
    // A current Legal Hold or retention obligation on a target never lets that target count as achieved.
    const unresolved = new Set(remaining);
    remaining = measure.targetContentRefs.filter((ref) => held.has(ref) || unresolved.has(ref));
    affected = affected.filter((ref) => !held.has(ref));
    return affected.length === 0
      ? conclude('BLOCKED', 'LEGAL_HOLD_OR_RETENTION_OBLIGATION_IS_CURRENT_ON_EVIDENCED_TARGET', affected, remaining)
      : conclude(
          'PARTIAL',
          'LEGAL_HOLD_OR_RETENTION_OBLIGATION_IS_CURRENT_ON_PART_OF_THE_EVIDENCED_TARGETS',
          affected,
          remaining,
        );
  }
  if (remaining.length === 0) {
    return conclude('ACHIEVED', 'EVERY_TARGET_EVIDENCED_BY_CONFIRMED_OWNER_ACTION');
  }
  if (affected.length > 0) {
    return conclude('PARTIAL', 'ONLY_PART_OF_THE_EXACT_SCOPE_IS_EVIDENCED');
  }
  if (partition.failedWithoutMutation.length > 0) {
    // Definite failure, nothing changed: the one outcome a later, separately confirmed attempt may follow.
    return conclude('TECHNICAL_FAILED', 'OWNER_ACTION_FAILED_BEFORE_ANY_MUTATION');
  }
  return conclude('PENDING', 'CONFIRMED_OWNER_ACTION_EVIDENCED_NO_TARGET', [], [...measure.targetContentRefs]);
};

/** NO_DATA is only believed when EVERY part is complete and nothing was found: the aggregate is re-derived, not trusted. */
const provesNoData = (coverage: PrivacyOwnerCoverageResultEncoded): boolean =>
  coverage.contentStatus === 'NO_DATA' &&
  coverage.coverageStatus === 'COMPLETE' &&
  coverage.coverageParts.every(
    ({ coverageStatus, foundContentRefs }) => coverageStatus === 'COMPLETE' && foundContentRefs.length === 0,
  );

/**
 * Evaluates Communications' truthful owner response to one approved Privacy Measure. Without matching, human-confirmed
 * evidence the answer is never ACHIEVED, PARTIAL or an anti-resurrection protection: it is PENDING (awaiting the human),
 * BLOCKED (a Current Legal Hold or retention obligation), NOT_APPLICABLE (complete coverage proves no such data) or
 * INDETERMINATE (the coverage cannot say). A retry carrying a changed identity is rejected. No caller-supplied previous
 * outcome is ever trusted.
 */
export const evaluateCommunicationsOwnerMeasure = (
  input: OwnerMeasureEvaluationInput,
): PrivacyOwnerExecutionOutcomeEncoded => {
  const { coverage, measure } = input;
  if (input.previousMeasure !== undefined && !isSameMeasureIdentity(input.previousMeasure, measure)) {
    return outcomeOf(input, 'BUSINESS_REJECTED', 'IDEMPOTENCY_IDENTITY_OR_MEASURE_SCOPE_CONFLICT', untouched(measure));
  }
  if (measure.scope.ownerCapability !== COMMUNICATIONS_OWNER_CAPABILITY) {
    return outcomeOf(input, 'BUSINESS_REJECTED', 'MEASURE_IS_NOT_FOR_COMMUNICATIONS', untouched(measure));
  }
  if (!isSameOwnerScope(coverage.scope, measure.scope)) {
    return outcomeOf(
      input,
      'BUSINESS_REJECTED',
      'OWNER_COVERAGE_SCOPE_DOES_NOT_MATCH_MEASURE_SCOPE',
      untouched(measure),
    );
  }
  const matching = input.evidence.filter((record) => evidenceBelongsToMeasure(record, measure));
  if (matching.length > 0) {
    return evaluateWithEvidence(input, matching);
  }
  if (provesNoData(coverage)) {
    return outcomeOf(input, 'NOT_APPLICABLE', 'COMPLETE_OWNER_SCOPE_CONFIRMS_NO_DATA', { affected: [], remaining: [] });
  }
  if (coverage.coverageStatus !== 'COMPLETE' && coverage.contentStatus !== 'FOUND') {
    return outcomeOf(input, 'INDETERMINATE', 'COMMUNICATIONS_OWNER_SCOPE_COVERAGE_INCOMPLETE', untouched(measure));
  }
  const held = heldRefsOf(input.blockerAssessment);
  if (measure.targetContentRefs.some((contentRef) => held.has(contentRef))) {
    return outcomeOf(input, 'BLOCKED', 'LEGAL_HOLD_OR_RETENTION_OBLIGATION_IS_CURRENT', untouched(measure));
  }
  const currentContent = currentlyFoundRefs(coverage);
  if (!measure.targetContentRefs.every((contentRef) => currentContent.has(contentRef))) {
    // Absence from partial coverage proves nothing; only complete coverage settles a target that is not there.
    return coverage.coverageStatus === 'COMPLETE'
      ? outcomeOf(
          input,
          'BUSINESS_REJECTED',
          'TARGET_CONTENT_NOT_IN_CURRENT_COMMUNICATIONS_COVERAGE',
          untouched(measure),
        )
      : outcomeOf(input, 'INDETERMINATE', 'COMMUNICATIONS_OWNER_SCOPE_COVERAGE_INCOMPLETE', untouched(measure));
  }
  return outcomeOf(
    input,
    'PENDING',
    input.blockerAssessment === undefined ? 'HOLD_APPLICABILITY_NOT_ASSESSED' : 'AWAITING_HUMAN_CONFIRMED_OWNER_ACTION',
    untouched(measure),
  );
};

/* ------------------------------------------------------------------------------------------------ */
/* Handoff record: who owns a pending obligation and what happens next                              */
/* ------------------------------------------------------------------------------------------------ */

export type ResponsibleOwner =
  | { readonly kind: 'ASSIGNED_HUMAN_OWNER'; readonly ownerRef: string }
  | {
      readonly escalateTo: GateOwner;
      readonly kind: 'UNASSIGNED_ESCALATE';
      readonly missingInput: 'HUMAN_DISPOSITION_OWNER';
    };

export const NextStepSchema = Schema.Literals([
  'ASSIGN_HUMAN_DISPOSITION_OWNER',
  'COMPLETE_REMAINING_TARGETS',
  'CONFIRM_EXACT_OWNER_ACTION_BY_AUTHORIZED_HUMAN',
  'RECONCILE_OWNER_STATE_BEFORE_ANY_RETRY',
  'RESOLVE_CURRENT_BLOCKER',
]);
export type NextStep = typeof NextStepSchema.Type;

/**
 * The traceable record of an obligation Privacy handed over. It carries NO deadline: the time limit is the law's and the
 * approved process's, and no SLA is invented here. `destructiveActionPerformed` is a literal `false`: the type cannot say
 * otherwise. Repeating the handoff or reaching a retention boundary yields the same record.
 */
export interface MeasureHandoffRecord {
  readonly destructiveActionPerformed: false;
  readonly measureRef: string;
  readonly nextStep: NextStep;
  readonly outcomeStatus: OutcomeStatus;
  readonly remainingContentRefs: readonly string[];
  readonly responsibleOwner: ResponsibleOwner;
  readonly sourceDecisionRef: string;
  readonly sourceDecisionRevision: string;
  readonly timeLimit: 'SET_BY_APPROVED_PROCESS_NOT_BY_THIS_OWNER';
}

const nextStepOf = (status: OutcomeStatus, assigned: boolean): NextStep => {
  if (status === 'BLOCKED') {
    return 'RESOLVE_CURRENT_BLOCKER';
  }
  if (status === 'INDETERMINATE') {
    return 'RECONCILE_OWNER_STATE_BEFORE_ANY_RETRY';
  }
  if (!assigned) {
    return 'ASSIGN_HUMAN_DISPOSITION_OWNER';
  }
  return status === 'PARTIAL' ? 'COMPLETE_REMAINING_TARGETS' : 'CONFIRM_EXACT_OWNER_ACTION_BY_AUTHORIZED_HUMAN';
};

export const handoffRecordOf = (
  outcome: PrivacyOwnerExecutionOutcomeEncoded,
  humanDispositionOwnerRef?: string,
): MeasureHandoffRecord => ({
  destructiveActionPerformed: false,
  measureRef: outcome.measureRef,
  nextStep: nextStepOf(outcome.status, humanDispositionOwnerRef !== undefined),
  outcomeStatus: outcome.status,
  remainingContentRefs: [...outcome.remainingContentRefs],
  responsibleOwner:
    humanDispositionOwnerRef === undefined
      ? {
          escalateTo: INPUT_OWNER.HUMAN_DISPOSITION_OWNER,
          kind: 'UNASSIGNED_ESCALATE',
          missingInput: 'HUMAN_DISPOSITION_OWNER',
        }
      : { kind: 'ASSIGNED_HUMAN_OWNER', ownerRef: humanDispositionOwnerRef },
  sourceDecisionRef: outcome.sourceDecisionRef,
  sourceDecisionRevision: outcome.sourceDecisionRevision,
  timeLimit: 'SET_BY_APPROVED_PROCESS_NOT_BY_THIS_OWNER',
});

/** An outcome counts as an open obligation until the owner evidences every exact target. */
export const isOpenObligation = (outcome: PrivacyOwnerExecutionOutcomeEncoded): boolean =>
  outcome.status !== 'ACHIEVED' && outcome.status !== 'NOT_APPLICABLE' && outcome.status !== 'BUSINESS_REJECTED';

/* ------------------------------------------------------------------------------------------------ */
/* External copy inventory (#603)                                                                   */
/* ------------------------------------------------------------------------------------------------ */

/** One fact that a provider was handed a message: an accepted handoff attempt or a provider observation of it. */
export interface ProviderObservationFact {
  readonly observedAtMillis: number;
  readonly providerKey: string;
}

export interface ExternalCopyHolder {
  readonly firstObservedAt: DateTime.Utc;
  readonly holderRef: string;
  readonly lastObservedAt: DateTime.Utc;
  /** A provider request is never evidence of provider-side disposition: that evidence is step 22's. */
  readonly providerSideDispositionEvidence: 'NOT_HELD_BY_COMMUNICATIONS';
  /**
   * - `CURRENT_TRANSPORT`: the deployment SAID that this is the provider it uses now;
   * - `PRIOR_PROVIDER`: it was handed messages and the deployment says a DIFFERENT provider is current now;
   * - `HISTORICAL_TRANSPORT`: it was handed messages and nobody told Communications which provider is current, so it
   *   claims neither. The latest fact is never taken for the current transport: it only says who was handed a message last.
   */
  readonly relationship: 'CURRENT_TRANSPORT' | 'HISTORICAL_TRANSPORT' | 'PRIOR_PROVIDER';
}

/**
 * The known external holders of a copy, from every provider that was handed a message (accepted handoff attempts AND
 * provider observations). Replacing a provider keeps every earlier holder: a provider change never erases a historical
 * obligation (#603) and nothing here asks any provider to delete anything. `currentProviderKey` is a deployment fact
 * (step 22's configured transport); without it no holder is called current.
 */
export const externalCopyInventoryOf = (
  facts: readonly ProviderObservationFact[],
  currentProviderKey?: string,
): readonly ExternalCopyHolder[] => {
  const byProvider = new Map<string, { first: number; last: number }>();
  for (const { observedAtMillis, providerKey } of facts) {
    const known = byProvider.get(providerKey);
    byProvider.set(providerKey, {
      first: Math.min(known?.first ?? observedAtMillis, observedAtMillis),
      last: Math.max(known?.last ?? observedAtMillis, observedAtMillis),
    });
  }
  const relationshipOf = (providerKey: string): ExternalCopyHolder['relationship'] => {
    if (currentProviderKey === undefined) {
      return 'HISTORICAL_TRANSPORT';
    }
    return providerKey === currentProviderKey ? 'CURRENT_TRANSPORT' : 'PRIOR_PROVIDER';
  };
  return [...byProvider.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([providerKey, { first, last }]) => ({
      firstObservedAt: DateTime.makeUnsafe(first),
      holderRef: `step-22-provider:${providerKey}`,
      lastObservedAt: DateTime.makeUnsafe(last),
      providerSideDispositionEvidence: 'NOT_HELD_BY_COMMUNICATIONS',
      relationship: relationshipOf(providerKey),
    }));
};

/* ------------------------------------------------------------------------------------------------ */
/* The manual-operable disposition process (AC-13), as a typed contract                             */
/* ------------------------------------------------------------------------------------------------ */

export const DispositionStepActorSchema = Schema.Literals([
  'AUTHORIZED_HUMAN',
  'COMMUNICATIONS_OBSERVATION_ONLY',
  'OWNER_ACTION',
  'PRIVACY_PROCESS',
]);
export type DispositionStepActor = typeof DispositionStepActorSchema.Type;

export interface ManualDispositionStep {
  readonly actor: DispositionStepActor;
  /** True only for the one step that may change owner data; it is never automated and never created by this lane. */
  readonly changesOwnerData: boolean;
  readonly key:
    | 'ANTI_RESURRECTION_PROTECTION_RECORDED'
    | 'AUTHORIZED_HUMAN_CONFIRMS_EXACT_OWNER_ACTION'
    | 'CURRENT_BLOCKERS_AND_LEGAL_HOLD_RECHECKED'
    | 'OBLIGATION_IDENTIFIED_AND_HANDED_TO_PRIVACY'
    | 'OWNER_ACTION_EXECUTED_FOR_THE_EXACT_SCOPE'
    | 'OWNER_EVIDENCES_THE_EXACT_OUTCOME'
    | 'PRIVACY_APPROVES_THE_EXACT_MEASURE';
}

/**
 * The process an approved obligation follows, as data. Only the owner Action step changes data, only a human starts it, and
 * the steps before and after it observe, decide, evidence or protect. The responsible owner and any time limit are inputs the
 * approved process supplies (`MeasureHandoffRecord.timeLimit`); none is invented here, and disabling automatic deletion is
 * not this process: an open obligation stays open and escalates through the handoff record until it is evidenced.
 */
export const manualDispositionProcess: readonly ManualDispositionStep[] = Object.freeze([
  {
    actor: 'COMMUNICATIONS_OBSERVATION_ONLY',
    changesOwnerData: false,
    key: 'OBLIGATION_IDENTIFIED_AND_HANDED_TO_PRIVACY',
  },
  { actor: 'PRIVACY_PROCESS', changesOwnerData: false, key: 'PRIVACY_APPROVES_THE_EXACT_MEASURE' },
  { actor: 'PRIVACY_PROCESS', changesOwnerData: false, key: 'CURRENT_BLOCKERS_AND_LEGAL_HOLD_RECHECKED' },
  { actor: 'AUTHORIZED_HUMAN', changesOwnerData: false, key: 'AUTHORIZED_HUMAN_CONFIRMS_EXACT_OWNER_ACTION' },
  { actor: 'OWNER_ACTION', changesOwnerData: true, key: 'OWNER_ACTION_EXECUTED_FOR_THE_EXACT_SCOPE' },
  { actor: 'COMMUNICATIONS_OBSERVATION_ONLY', changesOwnerData: false, key: 'OWNER_EVIDENCES_THE_EXACT_OUTCOME' },
  { actor: 'PRIVACY_PROCESS', changesOwnerData: false, key: 'ANTI_RESURRECTION_PROTECTION_RECORDED' },
]);
