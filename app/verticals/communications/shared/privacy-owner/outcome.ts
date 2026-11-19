import { DateTime, Match, Schema } from 'effect';
import type {
  PrivacyMeasureEncoded,
  PrivacyOwnerCoverageResultEncoded,
  PrivacyOwnerExecutionOutcomeEncoded,
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
  'FAILED_AFTER_POSSIBLE_MUTATION',
  'NOT_EXECUTED',
  'RECTIFIED',
  'REMOVED',
  'RESTRICTED',
]);
export type EvidencedTargetResult = typeof EvidencedTargetResultSchema.Type;

export interface OwnerExecutionEvidenceRecord {
  readonly confirmedAt: DateTime.Utc;
  /** The authorized human who separately confirmed THIS exact owner Action. Their identity is a reference only. */
  readonly confirmedByHumanRef: string;
  readonly evidenceRef: string;
  readonly measureRef: string;
  readonly ownerCapability: string;
  readonly phase: 'COMPLETED' | 'IN_PROGRESS';
  readonly requestedScopeRef: string;
  readonly results: readonly { readonly contentRef: string; readonly result: EvidencedTargetResult }[];
  readonly sourceDecisionRef: string;
  readonly sourceDecisionRevision: string;
  readonly tenantId: string;
}

export interface OwnerMeasureBlocker {
  readonly blockerRef: string;
  readonly contentRefs: readonly string[];
  readonly kind: 'LEGAL_HOLD' | 'RETENTION_OBLIGATION';
}

export interface OwnerMeasureEvaluationInput {
  readonly blockers: readonly OwnerMeasureBlocker[];
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

/** Evidence counts only when it names exactly this owner, tenant, scope, measure and source decision revision. */
export const evidenceBelongsToMeasure = (
  record: OwnerExecutionEvidenceRecord,
  measure: PrivacyMeasureEncoded,
): boolean =>
  record.ownerCapability === COMMUNICATIONS_OWNER_CAPABILITY &&
  measure.scope.ownerCapability === COMMUNICATIONS_OWNER_CAPABILITY &&
  record.tenantId === measure.scope.tenantId &&
  record.requestedScopeRef === measure.scope.requestedScopeRef &&
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

const isDestructive = (outcome: PrivacyMeasureEncoded['intendedOutcome']): boolean =>
  outcome === 'DELETE' || outcome === 'ANONYMIZE';

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

/** Partitions the exact targets by what matching, human-confirmed evidence reports for each of them. */
const partitionByEvidence = (measure: PrivacyMeasureEncoded, evidence: readonly OwnerExecutionEvidenceRecord[]) => {
  const accepted = new Set<EvidencedTargetResult>(achievedFor[measure.intendedOutcome]);
  const latest = new Map<string, EvidencedTargetResult>();
  for (const record of evidence.toSorted(
    (left, right) => DateTime.toEpochMillis(left.confirmedAt) - DateTime.toEpochMillis(right.confirmedAt),
  )) {
    for (const { contentRef, result } of record.results) {
      latest.set(contentRef, result);
    }
  }
  const affected = measure.targetContentRefs.filter((ref) => {
    const result = latest.get(ref);
    return result !== undefined && accepted.has(result);
  });
  const uncertain = measure.targetContentRefs.filter((ref) => latest.get(ref) === 'FAILED_AFTER_POSSIBLE_MUTATION');
  const affectedSet = new Set(affected);
  return {
    affected,
    remaining: measure.targetContentRefs.filter((ref) => !affectedSet.has(ref)),
    uncertain,
  };
};

const evaluateWithEvidence = (
  input: OwnerMeasureEvaluationInput,
  matching: readonly OwnerExecutionEvidenceRecord[],
): PrivacyOwnerExecutionOutcomeEncoded => {
  const { affected, remaining, uncertain } = partitionByEvidence(input.measure, matching);
  const evidenceRefs = [...new Set([...input.evidenceRefs, ...matching.map(({ evidenceRef }) => evidenceRef)])];
  if (uncertain.length > 0) {
    // A failure after a possible mutation is never retried or settled by a guess: the owner reconciles first.
    return outcomeOf(
      input,
      'INDETERMINATE',
      'OWNER_ACTION_FAILED_AFTER_POSSIBLE_MUTATION',
      { affected, remaining },
      evidenceRefs,
    );
  }
  if (matching.every(({ phase }) => phase === 'IN_PROGRESS')) {
    return outcomeOf(
      input,
      'IN_PROGRESS',
      'OWNER_ACTION_IN_PROGRESS_CONFIRMED_BY_HUMAN',
      { affected, remaining },
      evidenceRefs,
    );
  }
  if (remaining.length === 0) {
    return outcomeOf(
      input,
      'ACHIEVED',
      'EVERY_TARGET_EVIDENCED_BY_CONFIRMED_OWNER_ACTION',
      { affected, remaining },
      evidenceRefs,
    );
  }
  if (affected.length > 0) {
    return outcomeOf(
      input,
      'PARTIAL',
      'ONLY_PART_OF_THE_EXACT_SCOPE_IS_EVIDENCED',
      { affected, remaining },
      evidenceRefs,
    );
  }
  return outcomeOf(
    input,
    'PENDING',
    'CONFIRMED_OWNER_ACTION_EVIDENCED_NO_TARGET',
    untouched(input.measure),
    evidenceRefs,
  );
};

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
  if (coverage.contentStatus === 'NO_DATA') {
    return outcomeOf(input, 'NOT_APPLICABLE', 'COMPLETE_OWNER_SCOPE_CONFIRMS_NO_DATA', { affected: [], remaining: [] });
  }
  if (coverage.coverageStatus !== 'COMPLETE' && coverage.contentStatus !== 'FOUND') {
    return outcomeOf(input, 'INDETERMINATE', 'COMMUNICATIONS_OWNER_SCOPE_COVERAGE_INCOMPLETE', untouched(measure));
  }
  const targets = new Set(measure.targetContentRefs);
  if (
    isDestructive(measure.intendedOutcome) &&
    input.blockers.some(({ contentRefs }) => contentRefs.some((contentRef) => targets.has(contentRef)))
  ) {
    return outcomeOf(input, 'BLOCKED', 'LEGAL_HOLD_OR_RETENTION_OBLIGATION_IS_CURRENT', untouched(measure));
  }
  const currentContent = new Set(coverage.coverageParts.flatMap(({ foundContentRefs }) => foundContentRefs));
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
  return outcomeOf(input, 'PENDING', 'AWAITING_HUMAN_CONFIRMED_OWNER_ACTION', untouched(measure));
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
  /** `CURRENT_TRANSPORT` is the provider of the latest fact; every earlier one stays a known historical holder. */
  readonly relationship: 'CURRENT_TRANSPORT' | 'KNOWN_HISTORICAL_HOLDER';
}

/**
 * The known external holders of a copy, from the provider facts Communications keeps. Replacing a provider adds a current
 * one and keeps every earlier holder: a provider change never erases a historical obligation (#603) and nothing here asks
 * any provider to delete anything.
 */
export const externalCopyInventoryOf = (facts: readonly ProviderObservationFact[]): readonly ExternalCopyHolder[] => {
  const byProvider = new Map<string, { first: number; last: number }>();
  for (const { observedAtMillis, providerKey } of facts) {
    const known = byProvider.get(providerKey);
    byProvider.set(providerKey, {
      first: Math.min(known?.first ?? observedAtMillis, observedAtMillis),
      last: Math.max(known?.last ?? observedAtMillis, observedAtMillis),
    });
  }
  const latest = Math.max(...[...byProvider.values()].map(({ last }) => last), Number.NEGATIVE_INFINITY);
  return [...byProvider.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([providerKey, { first, last }]) => ({
      firstObservedAt: DateTime.makeUnsafe(first),
      holderRef: `step-22-provider:${providerKey}`,
      lastObservedAt: DateTime.makeUnsafe(last),
      providerSideDispositionEvidence: 'NOT_HELD_BY_COMMUNICATIONS',
      relationship: last === latest ? 'CURRENT_TRANSPORT' : 'KNOWN_HISTORICAL_HOLDER',
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
