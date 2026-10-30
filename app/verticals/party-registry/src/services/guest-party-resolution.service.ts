/* eslint-disable anti-slop-effect/no-service-constructor-imports -- ResourceRef helpers construct plain values, not Effect services. expires: 2026-12-31. */
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { DateTime, Effect, Option, Schema } from 'effect';

import type {
  GuestPartyResolutionResponse,
  GuestPartyResolutionRequest,
} from '../../shared/apis/guest-party-resolution.ts';
import {
  makePartyRef,
  PartyEvidenceEvaluationSchema,
  PartyPersistenceUnavailable,
  PartySubjectEligibilityVersion,
  PartySubjectEvidenceListSchema,
  PartyTypeRuleVersion,
} from '../../shared/domain/identity-contracts.ts';
import type { PartySubjectEvidence, PartyType } from '../../shared/domain/identity-contracts.ts';
import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';
import type { PartyTransaction } from '../db/types.ts';
import { resolvePartyAlias } from '../merge/party-alias-resolution.service.ts';
import {
  evaluatePartySubjectEvidence,
  partyGuestBindingFailure,
} from '../policies/create-party-without-strong-identifier.policy.ts';
import {
  duplicateCandidateCases,
  parties,
  partyContactPoints,
  partyFactAssertions,
  partyMatchDecisions,
  partyOfficialIdentifiers,
} from '../db/schema.ts';

interface GuestPartyResolutionPartyObservation {
  readonly archived: boolean;
  readonly partyId: string;
  readonly partyType: PartyType;
}

interface GuestPartyResolutionCaseObservation {
  readonly caseId: string;
  readonly lifecycleState: 'OPEN' | 'NEEDS_EVIDENCE' | 'RESOLVED' | 'DISMISSED';
  readonly resolutionOutcome: string | null;
  readonly selectedPartyId: string | null;
}

export interface GuestPartyIdentityProof {
  readonly created: boolean;
  readonly decisionId: string;
  readonly partyId: string;
  readonly subjectKey: string;
}

export interface GuestPartyResolutionObservations {
  readonly cases: readonly GuestPartyResolutionCaseObservation[];
  readonly partyIds: readonly string[];
  readonly identityProofs: readonly GuestPartyIdentityProof[];
  readonly parties: readonly GuestPartyResolutionPartyObservation[];
  readonly tenantId: string;
}

const invalid = (reason: string): GuestPartyResolutionResponse => ({
  outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE',
  reason,
});

const indeterminate: GuestPartyResolutionResponse = {
  outcome: 'PARTY_OWNER_INDETERMINATE',
  retryable: true,
};

/**
 * Classifies already tenant-filtered Party owner observations. This is intentionally pure so
 * cross-tenant, archived, duplicate, and unresolved outcomes can be tested without a database.
 */
export const classifyGuestPartyResolution = (
  observations: GuestPartyResolutionObservations,
): GuestPartyResolutionResponse => {
  const openCases = observations.cases.filter(
    ({ lifecycleState }) => lifecycleState === 'OPEN' || lifecycleState === 'NEEDS_EVIDENCE',
  );
  if (openCases.length > 1) {
    return indeterminate;
  }
  if (openCases.length === 1) {
    const [openCase] = openCases;
    return openCase === undefined
      ? indeterminate
      : {
          caseRef: makeDuplicateCandidateCaseRef(observations.tenantId, openCase.caseId),
          outcome: 'AMBIGUOUS_MATCH',
        };
  }

  const partyIds = [...new Set(observations.partyIds)].toSorted();
  if (partyIds.length > 1) {
    return indeterminate;
  }
  const [partyId] = partyIds;
  if (partyId === undefined) {
    return invalid('Guest evidence does not establish a Party identity');
  }

  const proofs = observations.identityProofs.filter((proof) => proof.partyId === partyId);
  if (proofs.length === 0) {
    return invalid('Guest evidence does not establish a Party identity');
  }
  if (new Set(proofs.map(({ subjectKey }) => subjectKey)).size !== 1) {
    return indeterminate;
  }

  const party = observations.parties.find((candidate) => candidate.partyId === partyId);
  if (party === undefined) {
    return indeterminate;
  }
  if (party.archived) {
    return invalid('Guest evidence identifies an archived Party');
  }
  if (party.partyType === 'UNRESOLVED' && !proofs.some(({ created }) => created)) {
    return invalid('Guest evidence does not establish a committed unresolved Party creation');
  }
  return party.partyType === 'UNRESOLVED'
    ? {
        outcome: 'UNRESOLVED_PARTY_CREATED',
        partyRef: makePartyRef(observations.tenantId, partyId),
      }
    : {
        outcome: 'EXISTING_PARTY_RESOLVED',
        partyRef: makePartyRef(observations.tenantId, partyId),
      };
};

const unavailable = (cause?: unknown) => {
  const failure = new PartyPersistenceUnavailable({
    code: 'party_persistence_unavailable',
    reason: 'Party guest-evidence resolution persistence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const requestedAtDate = (requestedAt: GuestPartyResolutionRequest['requestedAt']): Date =>
  DateTime.toDateUtc(requestedAt);

const activeAt = (
  column: {
    readonly state: Parameters<typeof eq>[0];
    readonly isCurrent: Parameters<typeof eq>[0];
    readonly validFrom: Parameters<typeof lte>[0];
    readonly validTo: Parameters<typeof gt>[0];
  },
  at: Date,
) =>
  and(
    eq(column.state, 'ACTIVE'),
    eq(column.isCurrent, true),
    lte(column.validFrom, at),
    or(isNull(column.validTo), gt(column.validTo, at)),
  );

// Drizzle has no JSON-path builder for bounded retained owner evidence membership.
const evidenceJsonContains = (column: AnyPgColumn, evidenceRef: string) =>
  sql`jsonb_path_exists(${column}, '$[*].evidenceRefs[*] ? (@ == $ref)', jsonb_build_object('ref', ${evidenceRef}::text))`;

const subjectEvidenceContains = (column: AnyPgColumn, evidenceRef: string) =>
  sql`jsonb_path_exists(${column}, '$.evidence[*] ? (@.evidenceRef == $ref)', jsonb_build_object('ref', ${evidenceRef}::text))`;

const snapshotEvidenceContains = (column: AnyPgColumn, evidenceRef: string) =>
  sql`jsonb_path_exists(${column}, '$.evidenceArtifactRefs[*] ? (@ == $ref)', jsonb_build_object('ref', ${evidenceRef}::text)) or jsonb_path_exists(${column}, '$.subjectEvidence[*] ? (@.evidenceRef == $ref)', jsonb_build_object('ref', ${evidenceRef}::text))`;

type GuestDecision = Pick<
  typeof partyMatchDecisions.$inferSelect,
  | 'actionInvocationId'
  | 'candidateFingerprint'
  | 'committedCreateOutcome'
  | 'decidedAt'
  | 'evidenceEvaluation'
  | 'matchDecisionId'
  | 'matchRuleVersion'
  | 'operation'
  | 'outcome'
  | 'partyId'
>;
type GuestReviewCase = Pick<
  typeof duplicateCandidateCases.$inferSelect,
  | 'candidateFingerprint'
  | 'candidateSnapshot'
  | 'lifecycleState'
  | 'matchRuleVersion'
  | 'resolutionActionInvocationId'
  | 'resolutionOutcome'
  | 'resolvedAt'
  | 'selectedPartyId'
>;

const supportedGuestDecisionOperation = (decision: GuestDecision): boolean => {
  const created = decision.outcome === 'CREATED' && decision.committedCreateOutcome === 'CREATED';
  const matched = decision.outcome === 'MATCHED';
  return (
    (decision.operation === 'CREATE' &&
      (created || (matched && decision.committedCreateOutcome === 'MATCHED_EXISTING'))) ||
    (decision.operation === 'MATCH' && matched && decision.committedCreateOutcome === null) ||
    (decision.operation === 'REVIEW_MATCH' && matched && decision.committedCreateOutcome === null) ||
    (decision.operation === 'REVIEW_CREATE' && created)
  );
};

const acceptedGuestSubjectEvidence = (
  decision: GuestDecision,
  input: GuestPartyResolutionRequest,
): PartySubjectEvidence | undefined => {
  const evaluation = decision.evidenceEvaluation;
  if (!Schema.is(PartyEvidenceEvaluationSchema)(evaluation)) {
    return undefined;
  }
  if (
    evaluation.subjectEligibilityVersion !== PartySubjectEligibilityVersion ||
    evaluation.typeRuleVersion !== PartyTypeRuleVersion ||
    !evaluation.subjectEligible ||
    !evaluation.typeSupported ||
    evaluation.reasonCode !== 'proven_concrete_subject' ||
    !evaluatePartySubjectEvidence({ partyType: 'UNRESOLVED', subjectEvidence: evaluation.evidence }).subjectEligible ||
    partyGuestBindingFailure(
      { subjectEvidence: evaluation.evidence },
      {
        legalEntityId: input.legalEntityRef.resourceId,
        tenantId: input.legalEntityRef.tenantId,
      },
    ) !== undefined
  ) {
    return undefined;
  }
  return evaluation.evidence.find(
    (item) =>
      item.evidenceRef === input.guestEvidenceRef &&
      item.guestBinding?.correlationRoot === input.correlationRoot &&
      item.guestBinding.legalEntityRef.tenantId === input.legalEntityRef.tenantId &&
      item.guestBinding.legalEntityRef.resourceId === input.legalEntityRef.resourceId,
  );
};

const acceptedGuestReview = (
  decision: GuestDecision,
  cases: readonly GuestReviewCase[],
  input: GuestPartyResolutionRequest,
  evidence: PartySubjectEvidence,
): boolean => {
  const at = DateTime.toEpochMillis(input.requestedAt);
  const review = cases.find(
    (candidate) =>
      candidate.lifecycleState === 'RESOLVED' &&
      candidate.resolutionActionInvocationId === decision.actionInvocationId &&
      candidate.candidateFingerprint === decision.candidateFingerprint &&
      candidate.matchRuleVersion === decision.matchRuleVersion &&
      candidate.selectedPartyId === decision.partyId &&
      candidate.resolutionOutcome === (decision.outcome === 'CREATED' ? 'CREATE_NEW' : 'MATCH_EXISTING'),
  );
  if (
    review === undefined ||
    review.resolvedAt === null ||
    !Number.isFinite(review.resolvedAt.getTime()) ||
    review.resolvedAt.getTime() > at ||
    !Schema.is(PartySubjectEvidenceListSchema)(review.candidateSnapshot.subjectEvidence)
  ) {
    return false;
  }
  const validFrom = DateTime.make(review.candidateSnapshot.validFrom);
  if (Option.isNone(validFrom) || DateTime.toEpochMillis(validFrom.value) > at) {
    return false;
  }
  return review.candidateSnapshot.subjectEvidence.some(
    (item) =>
      item.subjectKey === evidence.subjectKey &&
      item.evidenceRef === evidence.evidenceRef &&
      item.guestBinding?.correlationRoot === input.correlationRoot &&
      item.guestBinding.legalEntityRef.tenantId === input.legalEntityRef.tenantId &&
      item.guestBinding.legalEntityRef.resourceId === input.legalEntityRef.resourceId,
  );
};

/** The binding is accepted by the original authorized owner Action, never by this Read.
 * Historical/legacy decisions without exact Guest evidence cannot be promoted on lookup. */
export const qualifyGuestIdentityDecision = (
  decision: GuestDecision,
  cases: readonly GuestReviewCase[],
  input: GuestPartyResolutionRequest,
): GuestPartyIdentityProof | undefined => {
  if (
    decision.partyId === null ||
    decision.matchRuleVersion !== 'party-exact-claims.v1' ||
    !Number.isFinite(decision.decidedAt.getTime()) ||
    decision.decidedAt.getTime() > DateTime.toEpochMillis(input.requestedAt) ||
    !supportedGuestDecisionOperation(decision)
  ) {
    return undefined;
  }
  const evidence = acceptedGuestSubjectEvidence(decision, input);
  if (evidence === undefined) {
    return undefined;
  }
  if (
    (decision.operation === 'REVIEW_MATCH' || decision.operation === 'REVIEW_CREATE') &&
    !acceptedGuestReview(decision, cases, input, evidence)
  ) {
    return undefined;
  }
  return {
    created: decision.outcome === 'CREATED',
    decisionId: decision.matchDecisionId,
    partyId: decision.partyId,
    subjectKey: evidence.subjectKey,
  };
};

/**
 * Resolves only evidence already accepted by Party Registry. The operation does not create or
 * mutate a Party; Create New outcomes are observed from a previously committed review case.
 */
export const resolveGuestPartyEvidence = Effect.fn('GuestPartyResolutionService.resolveGuestPartyEvidence')(
  function* resolveGuestPartyEvidence(
    transaction: Pick<PartyTransaction, 'select'>,
    input: GuestPartyResolutionRequest,
  ) {
    const at = requestedAtDate(input.requestedAt);
    const evidenceRef = input.guestEvidenceRef;
    const acceptedEvidence = or(
      eq(partyFactAssertions.evidenceReference, evidenceRef),
      sql`${partyFactAssertions.externalEvidence}->>'evidenceRef' = ${evidenceRef}`,
    );
    const acceptedIdentifierEvidence = or(
      sql`${partyOfficialIdentifiers.externalEvidence}->>'evidenceRef' = ${evidenceRef}`,
    );
    const acceptedContactEvidence = or(
      eq(partyContactPoints.evidenceReference, evidenceRef),
      sql`${partyContactPoints.externalEvidence}->>'evidenceRef' = ${evidenceRef}`,
      sql`jsonb_path_exists(${partyContactPoints.additionalEvidenceRefs}, '$[*] ? (@ == $ref)', jsonb_build_object('ref', ${evidenceRef}::text))`,
    );

    const [factRows, identifierRows, contactRows, decisionRows, caseRows] = yield* Effect.all(
      [
        transaction
          .select({ partyId: partyFactAssertions.partyId })
          .from(partyFactAssertions)
          .where(
            and(
              eq(partyFactAssertions.tenantId, input.legalEntityRef.tenantId),
              acceptedEvidence,
              activeAt(partyFactAssertions, at),
            ),
          )
          .pipe(Effect.mapError(unavailable)),
        transaction
          .select({ partyId: partyOfficialIdentifiers.partyId })
          .from(partyOfficialIdentifiers)
          .where(
            and(
              eq(partyOfficialIdentifiers.tenantId, input.legalEntityRef.tenantId),
              acceptedIdentifierEvidence,
              activeAt(partyOfficialIdentifiers, at),
            ),
          )
          .pipe(Effect.mapError(unavailable)),
        transaction
          .select({ partyId: partyContactPoints.partyId })
          .from(partyContactPoints)
          .where(
            and(
              eq(partyContactPoints.tenantId, input.legalEntityRef.tenantId),
              acceptedContactEvidence,
              activeAt(partyContactPoints, at),
            ),
          )
          .pipe(Effect.mapError(unavailable)),
        transaction
          .select()
          .from(partyMatchDecisions)
          .where(
            and(
              eq(partyMatchDecisions.tenantId, input.legalEntityRef.tenantId),
              or(
                evidenceJsonContains(partyMatchDecisions.evidenceExplanation, evidenceRef),
                subjectEvidenceContains(partyMatchDecisions.evidenceEvaluation, evidenceRef),
              ),
              inArray(partyMatchDecisions.outcome, ['CREATED', 'MATCHED']),
            ),
          )
          .pipe(Effect.mapError(unavailable)),
        transaction
          .select()
          .from(duplicateCandidateCases)
          .where(
            and(
              eq(duplicateCandidateCases.tenantId, input.legalEntityRef.tenantId),
              snapshotEvidenceContains(duplicateCandidateCases.candidateSnapshot, evidenceRef),
            ),
          )
          .pipe(Effect.mapError(unavailable)),
      ],
      { concurrency: 1 },
    );

    const partyIds = [
      ...factRows.map(({ partyId }) => partyId),
      ...identifierRows.map(({ partyId }) => partyId),
      ...contactRows.map(({ partyId }) => partyId),
      ...decisionRows.flatMap(({ partyId }) => (partyId === null ? [] : [partyId])),
      ...caseRows.flatMap(({ selectedPartyId }) => (selectedPartyId === null ? [] : [selectedPartyId])),
    ];
    const identities = yield* Effect.forEach(
      [...new Set(partyIds)].toSorted(),
      (partyId) =>
        resolvePartyAlias(transaction, input.legalEntityRef.tenantId, partyId).pipe(Effect.mapError(unavailable)),
      { concurrency: 1 },
    );
    const canonicalId = (partyId: string) =>
      identities.find((identity) => identity.requestedPartyId === partyId)?.canonicalPartyId ?? partyId;
    const uniquePartyIds = [...new Set(identities.map(({ canonicalPartyId }) => canonicalPartyId))].toSorted();
    const identityProofs = decisionRows.flatMap((decision) => {
      const proof = qualifyGuestIdentityDecision(decision, caseRows, input);
      return proof === undefined ? [] : [{ ...proof, partyId: canonicalId(proof.partyId) }];
    });
    const partyRows =
      uniquePartyIds.length === 0
        ? []
        : yield* transaction
            .select({
              archivedAt: parties.archivedAt,
              partyId: parties.partyId,
              partyType: parties.currentType,
            })
            .from(parties)
            .where(and(eq(parties.tenantId, input.legalEntityRef.tenantId), inArray(parties.partyId, uniquePartyIds)))
            .pipe(Effect.mapError(unavailable));

    return classifyGuestPartyResolution({
      cases: caseRows.map((row) => ({
        caseId: row.candidateCaseId,
        // SAFETY: the duplicate-candidate lifecycle CHECK constrains this value to the closed set.
        lifecycleState: row.lifecycleState as GuestPartyResolutionCaseObservation['lifecycleState'],
        resolutionOutcome: row.resolutionOutcome,
        selectedPartyId: row.selectedPartyId,
      })),
      identityProofs,
      partyIds: uniquePartyIds,
      parties: partyRows.map((row) => ({
        archived: row.archivedAt !== null,
        partyId: row.partyId,
        // SAFETY: the Party current-type CHECK constrains this value to PartyType.
        partyType: row.partyType as PartyType,
      })),
      tenantId: input.legalEntityRef.tenantId,
    });
  },
);
