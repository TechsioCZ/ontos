import {
  normalizePrivacyMeasureHandoff,
  PrivacyMeasureHandoffSchema,
} from '@app/privacy/domain/privacy-measure-handoff';
import type { OwnerExecutionOutcome, PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { PrivacyMeasureSchema } from '@app/shared-contracts';
import type { PrivacyMeasureEncoded, PrivacyOwnerExecutionOutcomeEncoded } from '@app/shared-contracts';
import { Crypto, DateTime, Effect, Match, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { CommunicationsOwnerLookupSchema } from '../apis/privacy-owner-coverage.ts';
import type { CommunicationsOwnerLookup } from '../apis/privacy-owner-coverage.ts';
import { COMMUNICATIONS_OWNER_CAPABILITY } from './inventory.ts';
import type { OwnerBlockerAssessment, OwnerExecutionEvidenceRecord } from './outcome.ts';

/**
 * How a measure Privacy handed over becomes the owner contract's measure (#595-#605) and how the owner's answer becomes
 * Privacy's own Owner Execution Outcome vocabulary. Nothing here executes anything, reads anything or invents a value: the
 * measure is exactly what the handoff's own fields and its owner scope say, and an unmappable handoff is rejected by name.
 */

const DispatchedMeasureSchema = PrivacyMeasureSchema;

/** Why the owner cannot evaluate a handed-over measure at all. A rejection is a truthful BUSINESS_REJECTED answer. */
export const MeasureRejectionSchema = Schema.Literals([
  'EXPORT_IS_NOT_A_COMMUNICATIONS_OWNER_MEASURE',
  'HANDOFF_DOES_NOT_MATCH_THE_RECORDED_HANDOFF',
  'HANDOFF_IS_NOT_FOR_COMMUNICATIONS',
  'HANDOFF_OWNER_SCOPE_DOES_NOT_NAME_THE_SUBJECT_LOOKUPS_OF_THE_MEASURE',
  'HANDOFF_OWNER_SCOPE_IS_ABSENT_OR_INVALID',
  'RECORDED_OWNER_SCOPE_DIGEST_DOES_NOT_MATCH_THE_HANDOFF',
  'RESTRICTION_KIND_IS_AMBIGUOUS',
]);
export type MeasureRejection = typeof MeasureRejectionSchema.Type;

export interface DispatchedMeasure {
  /** Privacy's blocker assessment of this measure, exactly as the handoff carries it; absent means NOT assessed. */
  readonly blockerAssessment?: OwnerBlockerAssessment | undefined;
  readonly lookups: readonly CommunicationsOwnerLookup[];
  readonly measure: PrivacyMeasureEncoded;
}

const intendedOutcomeOf = (
  handoff: PrivacyMeasureHandoff,
): PrivacyMeasureEncoded['intendedOutcome'] | MeasureRejection =>
  Match.value(handoff.kind).pipe(
    Match.when('DELETE', () => 'DELETE' as const),
    Match.when('ANONYMIZE', () => 'ANONYMIZE' as const),
    Match.when('RECTIFY', () => 'RECTIFY' as const),
    Match.when('EXPORT', () => 'EXPORT_IS_NOT_A_COMMUNICATIONS_OWNER_MEASURE' as const),
    Match.when('RESTRICT', () => {
      if (handoff.dispositionDecision === 'RESTRICT') {
        return 'ENFORCE_DISPOSITION_RESTRICTION' as const;
      }
      return handoff.dispositionDecision === null && handoff.requestedResult.toLowerCase().includes('processing')
        ? ('ENFORCE_PROCESSING_RESTRICTION' as const)
        : ('RESTRICTION_KIND_IS_AMBIGUOUS' as const);
    }),
    Match.exhaustive,
  );

const decodeLookups = Schema.decodeUnknownResult(Schema.Array(CommunicationsOwnerLookupSchema));
const decodeMeasure = Schema.decodeUnknownResult(DispatchedMeasureSchema);
const encodeMeasure = Schema.encodeResult(DispatchedMeasureSchema);

/**
 * The owner-contract measure of a handoff: Privacy's own fields (owner capability, tenant, subject, DSR controller
 * obligation, source decision, targets) plus the exact owner scope the handoff carries. The targets are the handoff's own
 * Resource references, so what the owner answers partitions exactly what Privacy approved.
 */
export const communicationsMeasureOf = (
  handoff: PrivacyMeasureHandoff,
): Result.Result<DispatchedMeasure, MeasureRejection> => {
  if (handoff.owningCapability !== COMMUNICATIONS_OWNER_CAPABILITY) {
    return Result.fail('HANDOFF_IS_NOT_FOR_COMMUNICATIONS');
  }
  const { ownerScope } = handoff;
  if (ownerScope === undefined) {
    return Result.fail('HANDOFF_OWNER_SCOPE_IS_ABSENT_OR_INVALID');
  }
  const intendedOutcome = intendedOutcomeOf(handoff);
  if (
    intendedOutcome === 'EXPORT_IS_NOT_A_COMMUNICATIONS_OWNER_MEASURE' ||
    intendedOutcome === 'RESTRICTION_KIND_IS_AMBIGUOUS'
  ) {
    return Result.fail(intendedOutcome);
  }
  const lookups = decodeLookups(ownerScope.trustedLookups);
  if (Result.isFailure(lookups)) {
    return Result.fail('HANDOFF_OWNER_SCOPE_DOES_NOT_NAME_THE_SUBJECT_LOOKUPS_OF_THE_MEASURE');
  }
  const scope = {
    controllerRef: ownerScope.controllerRef,
    ownerCapability: handoff.owningCapability,
    requestedScopePartRefs: ownerScope.requestedScopePartRefs,
    requestedScopeRef: ownerScope.requestedScopeRef,
    subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: handoff.subjectRef },
    tenantId: handoff.tenantId,
    trustedLookupRefs: ownerScope.trustedLookups.map(({ lookupRef }) => lookupRef),
  };
  const raw = {
    expectedEvidenceRefs: handoff.expectedEvidenceRefs,
    idempotencyKey: handoff.idempotencyKey,
    intendedOutcome,
    measureRef: handoff.measureId,
    preconditionRefs: handoff.preconditionRefs,
    requestedAt: handoff.requestedAt,
    scope:
      handoff.controllerObligationRef === null
        ? scope
        : { ...scope, dsrControllerObligationRef: handoff.controllerObligationRef },
    sourceDecisionRef: handoff.sourceDecisionRef,
    sourceDecisionRevision: String(handoff.sourceDecisionRevision),
    targetContentRefs: handoff.resourceRefs,
  };
  const decoded = decodeMeasure(raw).pipe(Result.flatMap(encodeMeasure));
  return Result.isFailure(decoded)
    ? Result.fail('HANDOFF_OWNER_SCOPE_IS_ABSENT_OR_INVALID')
    : Result.succeed({
        blockerAssessment: ownerScope.blockerAssessment,
        lookups: lookups.success,
        measure: decoded.success,
      });
};

/* ------------------------------------------------------------------------------------------------ */
/* Digests                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

const lengthPrefixed = (parts: readonly string[]): string =>
  parts.map((part) => `${String(part.length)}:${part}`).join('|');

const lookupKeyOf = (lookup: CommunicationsOwnerLookup): string =>
  Match.value(lookup).pipe(
    Match.tag('ACTOR_PRINCIPAL', ({ lookupRef, principalId }) =>
      lengthPrefixed(['ACTOR_PRINCIPAL', lookupRef, principalId]),
    ),
    Match.tag('CONTACT_REFERENCE', ({ lookupRef, moduleId, resourceId, resourceType }) =>
      lengthPrefixed(['CONTACT_REFERENCE', lookupRef, moduleId, resourceType, resourceId]),
    ),
    Match.tag('SUBJECT_REFERENCE', ({ lookupRef, moduleId, resourceId, resourceType }) =>
      lengthPrefixed(['SUBJECT_REFERENCE', lookupRef, moduleId, resourceType, resourceId]),
    ),
    Match.exhaustive,
  );

const subjectKeyOf = (subject: PrivacyMeasureEncoded['scope']['subject']): string =>
  Match.value(subject).pipe(
    Match.tag('RESOLVED_DATA_SUBJECT', ({ subjectRef }) => `S:${subjectRef}`),
    Match.tag('ANONYMOUS_PRIVACY_CONTEXT', ({ contextRef }) => `A:${contextRef}`),
    Match.exhaustive,
  );

/**
 * The canonical text of the exact owner scope of a measure: owner, tenant, controller, subject, requested scope and its
 * parts, and the typed lookups, in a fixed order. Evidence is bound to a measure through the digest of this text only, so no
 * subject, lookup or controller is stored by the owner.
 */
export const ownerScopeCanonicalText = ({ lookups, measure }: DispatchedMeasure): string =>
  lengthPrefixed([
    measure.scope.tenantId,
    measure.scope.ownerCapability,
    measure.scope.controllerRef,
    measure.scope.dsrControllerObligationRef ?? '',
    measure.scope.requestedScopeRef,
    subjectKeyOf(measure.scope.subject),
    lengthPrefixed(measure.scope.requestedScopePartRefs.toSorted()),
    lengthPrefixed(lookups.map(lookupKeyOf).toSorted()),
  ]);

export const sha256Hex = Effect.fn('Communications.PrivacyMeasure.sha256')(function* sha256Hex(text: string) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(yield* crypto.digest('SHA-256', new TextEncoder().encode(text)));
});

const encodeHandoff = Schema.encodeEffect(Schema.fromJsonString(PrivacyMeasureHandoffSchema));

/**
 * The fingerprint of the exact complete handoff, computed with the SAME codec and normalization Privacy applies to the same
 * handoff (reference sets sorted), so the receipt attests "this is the handoff I received" without Privacy trusting a
 * caller-supplied copy.
 */
export const fingerprintCommunicationsHandoff = Effect.fn('Communications.PrivacyMeasure.fingerprint')(
  function* fingerprint(handoff: PrivacyMeasureHandoff) {
    return yield* sha256Hex(yield* encodeHandoff(normalizePrivacyMeasureHandoff(handoff)));
  },
);

/* ------------------------------------------------------------------------------------------------ */
/* The owner's answer in Privacy's vocabulary                                                       */
/* ------------------------------------------------------------------------------------------------ */

/** Privacy's reference to the human who confirmed an owner Action: the Core invocation that carried the confirmation. */
export const confirmationRefOf = (confirmationInvocationId: string): string =>
  `communications.core.action-invocation:${confirmationInvocationId}`;

export interface StoredExecutionEvidence {
  readonly confirmationInvocationId: string;
  readonly evidenceRef: string;
  readonly phase: OwnerExecutionEvidenceRecord['phase'];
  readonly recordedAt: DateTime.Utc;
  readonly results: OwnerExecutionEvidenceRecord['results'];
  readonly scopeDigest: string;
}

/**
 * Evidence rows bound to the exact scope of THIS measure by digest become records of the evaluator; a row of another scope is
 * never evidence for this measure (it is not even handed to the evaluator).
 */
export const evidenceRecordsOf = (
  rows: readonly StoredExecutionEvidence[],
  measure: PrivacyMeasureEncoded,
  scopeDigest: string,
): readonly OwnerExecutionEvidenceRecord[] => {
  const records: OwnerExecutionEvidenceRecord[] = [];
  for (const row of rows) {
    if (row.scopeDigest === scopeDigest) {
      records.push({
        confirmedAt: row.recordedAt,
        confirmedByHumanRef: confirmationRefOf(row.confirmationInvocationId),
        evidenceRef: row.evidenceRef,
        measureRef: measure.measureRef,
        phase: row.phase,
        results: row.results,
        scope: measure.scope,
        sourceDecisionRef: measure.sourceDecisionRef,
        sourceDecisionRevision: measure.sourceDecisionRevision,
      });
    }
  }
  return records;
};

/**
 * Only the statuses Privacy's vocabulary and the Symmy/Party owners share keep their name. ACHIEVED is Privacy's SUCCEEDED, and
 * a measure the owner took over with nothing started (PENDING the human) is Privacy's RECEIVED, which is also the state its own
 * coordinator holds for a dispatched measure with no outcome yet. Nothing else is renamed.
 */
const privacyStatusOf = (status: PrivacyOwnerExecutionOutcomeEncoded['status']): OwnerExecutionOutcome['status'] =>
  Match.value(status).pipe(
    Match.when('ACHIEVED', () => 'SUCCEEDED' as const),
    Match.when('PENDING', () => 'RECEIVED' as const),
    Match.orElse((same) => same),
  );

export interface ReceiptOutcomeInput {
  readonly attempt: number;
  readonly handoff: PrivacyMeasureHandoff;
  readonly occurredAt: DateTime.Utc;
  readonly outcomeId: string;
  readonly recordedAt: DateTime.Utc;
}

/**
 * Privacy's Owner Execution Outcome for the owner's answer. Privacy requires every approved Resource to be either included or
 * remaining, so an outcome that settles nothing (including NOT_APPLICABLE and a rejection) leaves every Resource remaining,
 * exactly as the Party Registry owner reports a rejection.
 */
export const privacyOutcomeOf = (
  input: ReceiptOutcomeInput & { readonly outcome: PrivacyOwnerExecutionOutcomeEncoded },
): OwnerExecutionOutcome => {
  const { handoff, outcome } = input;
  const status = privacyStatusOf(outcome.status);
  const settles = status === 'SUCCEEDED' || status === 'PARTIAL';
  return {
    attempt: input.attempt,
    evidenceRefs: outcome.evidenceRefs,
    idempotencyKey: handoff.idempotencyKey,
    includedResourceRefs: settles ? [...outcome.affectedContentRefs] : [],
    measureId: handoff.measureId,
    occurredAt: DateTime.formatIso(input.occurredAt),
    outcomeId: input.outcomeId,
    owningCapability: handoff.owningCapability,
    reason: outcome.reason,
    recordedAt: DateTime.formatIso(input.recordedAt),
    remainingResourceRefs: settles ? [...outcome.remainingContentRefs] : [...handoff.resourceRefs],
    sourceDecisionRef: handoff.sourceDecisionRef,
    sourceDecisionRevision: handoff.sourceDecisionRevision,
    status,
    taskId: handoff.taskId,
  };
};

/** A handoff the owner cannot evaluate at all: Privacy's truthful BUSINESS_REJECTED with every Resource remaining. */
export const rejectedOutcomeOf = (
  input: ReceiptOutcomeInput & { readonly evidenceRefs: readonly string[]; readonly reason: MeasureRejection },
): OwnerExecutionOutcome => ({
  attempt: input.attempt,
  evidenceRefs: [...input.evidenceRefs],
  idempotencyKey: input.handoff.idempotencyKey,
  includedResourceRefs: [],
  measureId: input.handoff.measureId,
  occurredAt: DateTime.formatIso(input.occurredAt),
  outcomeId: input.outcomeId,
  owningCapability: input.handoff.owningCapability,
  reason: input.reason,
  recordedAt: DateTime.formatIso(input.recordedAt),
  remainingResourceRefs: [...input.handoff.resourceRefs],
  sourceDecisionRef: input.handoff.sourceDecisionRef,
  sourceDecisionRevision: input.handoff.sourceDecisionRevision,
  status: 'BUSINESS_REJECTED',
  taskId: input.handoff.taskId,
});
