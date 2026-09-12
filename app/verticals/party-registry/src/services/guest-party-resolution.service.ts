/* eslint-disable anti-slop-effect/no-service-constructor-imports -- ResourceRef helpers construct plain values, not Effect services. expires: 2026-12-31. */
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { DateTime, Effect } from 'effect';

import type {
  GuestPartyResolutionResponse,
  GuestPartyResolutionRequest,
} from '../../shared/apis/guest-party-resolution.ts';
import { makePartyRef, PartyPersistenceUnavailable } from '../../shared/domain/identity-contracts.ts';
import type { PartyType } from '../../shared/domain/identity-contracts.ts';
import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';
import type { PartyTransaction } from '../db/types.ts';
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

export interface GuestPartyResolutionObservations {
  readonly cases: readonly GuestPartyResolutionCaseObservation[];
  readonly partyIds: readonly string[];
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

  const party = observations.parties.find((candidate) => candidate.partyId === partyId);
  if (party === undefined) {
    return indeterminate;
  }
  if (party.archived) {
    return invalid('Guest evidence identifies an archived Party');
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

const evidenceJsonContains = (column: AnyPgColumn, evidenceRef: string) =>
  sql`jsonb_path_exists(${column}, '$[*].evidenceRefs[*] ? (@ == $ref)', jsonb_build_object('ref', ${evidenceRef}))`;

const snapshotEvidenceContains = (column: AnyPgColumn, evidenceRef: string) =>
  sql`jsonb_path_exists(${column}, '$.evidenceArtifactRefs[*] ? (@ == $ref)', jsonb_build_object('ref', ${evidenceRef}))`;

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
      sql`jsonb_path_exists(${partyContactPoints.additionalEvidenceRefs}, '$[*] ? (@ == $ref)', jsonb_build_object('ref', ${evidenceRef}))`,
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
          .select({
            outcome: partyMatchDecisions.outcome,
            partyId: partyMatchDecisions.partyId,
          })
          .from(partyMatchDecisions)
          .where(
            and(
              eq(partyMatchDecisions.tenantId, input.legalEntityRef.tenantId),
              evidenceJsonContains(partyMatchDecisions.evidenceExplanation, evidenceRef),
              inArray(partyMatchDecisions.outcome, ['CREATED', 'MATCHED']),
            ),
          )
          .pipe(Effect.mapError(unavailable)),
        transaction
          .select({
            candidateCaseId: duplicateCandidateCases.candidateCaseId,
            lifecycleState: duplicateCandidateCases.lifecycleState,
            resolutionOutcome: duplicateCandidateCases.resolutionOutcome,
            selectedPartyId: duplicateCandidateCases.selectedPartyId,
          })
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
    const uniquePartyIds = [...new Set(partyIds)].toSorted();
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
