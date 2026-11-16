import type { OperationalScope } from '@app/core-runtime';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { OrganizationBusinessNameExportRequestSchema } from '../../shared/apis/organization-business-name-export.ts';
import type { SourcePartySearchRequest, SourcePartySearchResponse } from '../../shared/apis/source-party-search.ts';
import { PartyPersistenceUnavailable } from '../../shared/domain/identity-contracts.ts';
import type { PartyPersistenceUnavailableError } from '../../shared/domain/identity-contracts.ts';
import { parties, partyAliases, partyContactPoints, partyFactAssertions } from '../db/schema.ts';
import type { PartyTransaction } from '../db/types.ts';
import { isOrganizationBusinessNameExportAllowed } from './organization-business-name-export.service.ts';
import { authorizePartyClientSourceReference } from './party-client-source-evidence.service.ts';
import { withPartyClientSourceRequest } from './party-client-source-privacy.service.ts';
import { loadAuthorizedSourceCorrelatedParty } from './source-person-admission.service.ts';

type Candidate = SourcePartySearchRequest['candidates'][number];
type SearchTransaction = Pick<PartyTransaction, 'select'>;

const unavailable = (cause?: unknown) =>
  Object.assign(
    new PartyPersistenceUnavailable({
      code: 'party_persistence_unavailable',
      reason: 'Source Party search or current Privacy authority is unavailable',
    }),
    { cause },
  );

/** A literal, case-insensitive substring test: `position` has no wildcard, so `%`, `_` and `\` are ordinary text. */
const containsTerm = (column: AnyColumn, term: string) =>
  sql`position(lower(${term}::text) in lower(coalesce(${column}, ''))) > 0`;

/** The Parties of the candidates that still exist as their own current record, with the kind Privacy is asked about. */
const currentCandidateTypes = Effect.fn('SourcePartySearch.candidateTypes')(function* candidateTypes(
  transaction: SearchTransaction,
  scope: OperationalScope,
  partyIds: readonly string[],
) {
  if (partyIds.length === 0) {
    return [];
  }
  return yield* transaction
    .select({ partyId: parties.partyId, currentType: parties.currentType })
    .from(parties)
    .where(
      and(
        eq(parties.tenantId, scope.tenantId),
        inArray(parties.partyId, [...partyIds]),
        isNull(parties.archivedAt),
        sql`not exists (select 1 from ${partyAliases} where ${partyAliases.tenantId} = ${parties.tenantId} and ${partyAliases.aliasPartyId} = ${parties.partyId})`,
      ),
    )
    .pipe(Effect.mapError(unavailable));
});

/** The exact fields `source-profile-export` returns for a PERSON: names, business name and current email/phone. */
const personTermMatches = Effect.fn('SourcePartySearch.personTermMatches')(function* personMatches(
  transaction: SearchTransaction,
  scope: OperationalScope,
  partyIds: readonly string[],
  term: string,
  now: Date,
) {
  if (partyIds.length === 0) {
    return [];
  }
  const rows = yield* transaction
    .select({ partyId: parties.partyId })
    .from(parties)
    .where(
      and(
        eq(parties.tenantId, scope.tenantId),
        inArray(parties.partyId, [...partyIds]),
        or(
          containsTerm(parties.firstName, term),
          containsTerm(parties.lastName, term),
          containsTerm(parties.businessName, term),
          sql`exists (select 1 from ${partyContactPoints} where ${partyContactPoints.tenantId} = ${parties.tenantId}
            and ${partyContactPoints.partyId} = ${parties.partyId}
            and ${partyContactPoints.contactPointType} in ('EMAIL', 'PHONE')
            and ${partyContactPoints.state} = 'ACTIVE' and ${partyContactPoints.isCurrent} = true
            and ${partyContactPoints.validFrom} <= ${now}
            and (${partyContactPoints.validTo} is null or ${partyContactPoints.validTo} > ${now})
            and (${containsTerm(partyContactPoints.normalizedValue, term)} or ${containsTerm(partyContactPoints.displayValue, term)}))`,
        ),
      ),
    )
    .pipe(Effect.mapError(unavailable));
  return rows.map(({ partyId }) => partyId);
});

/** The exact value `organization-business-name-export` returns: the one current BUSINESS_NAME assertion. */
const organizationTermMatches = Effect.fn('SourcePartySearch.organizationTermMatches')(function* orgMatches(
  transaction: SearchTransaction,
  scope: OperationalScope,
  partyIds: readonly string[],
  term: string,
  now: Date,
) {
  if (partyIds.length === 0) {
    return [];
  }
  const rows = yield* transaction
    .select({ partyId: partyFactAssertions.partyId })
    .from(partyFactAssertions)
    .where(
      and(
        eq(partyFactAssertions.tenantId, scope.tenantId),
        inArray(partyFactAssertions.partyId, [...partyIds]),
        eq(partyFactAssertions.factKind, 'BUSINESS_NAME'),
        eq(partyFactAssertions.state, 'ACTIVE'),
        eq(partyFactAssertions.isCurrent, true),
        lte(partyFactAssertions.validFrom, now),
        or(isNull(partyFactAssertions.validTo), gt(partyFactAssertions.validTo, now)),
        containsTerm(partyFactAssertions.normalizedValue, term),
      ),
    )
    .pipe(Effect.mapError(unavailable));
  return rows.map(({ partyId }) => partyId);
});

/** Source correlation and current `PROFILE_EXPORT` Privacy, exactly as the export applies them. A refusal is `false`. */
const personProfileAllowed = Effect.fn('SourcePartySearch.personProfileAllowed')(function* allowed(
  transaction: SearchTransaction,
  scope: OperationalScope,
  candidate: Candidate,
) {
  const evidence = yield* authorizePartyClientSourceReference(candidate.sourceReference, scope, {
    operation: 'EVIDENCE_READ',
  }).pipe(
    Effect.as(true),
    Effect.catchTag('PartyEvidenceInsufficient', () => Effect.succeed(false)),
  );
  if (!evidence) {
    return false;
  }
  const correlated = yield* loadAuthorizedSourceCorrelatedParty(transaction, scope, candidate);
  if (correlated === undefined) {
    return false;
  }
  return yield* authorizePartyClientSourceReference(candidate.sourceReference, scope, {
    operation: 'PROFILE_EXPORT',
    target: { kind: 'PARTY', partyId: correlated.party.partyId },
  }).pipe(
    Effect.as(true),
    Effect.catchTag('PartyEvidenceInsufficient', () => Effect.succeed(false)),
  );
});

const organizationNameAllowed = Effect.fn('SourcePartySearch.organizationNameAllowed')(function* allowed(
  transaction: SearchTransaction,
  scope: OperationalScope,
  candidate: Candidate,
) {
  const request = yield* Schema.decodeUnknownEffect(OrganizationBusinessNameExportRequestSchema)(candidate).pipe(
    Effect.mapError(unavailable),
  );
  const encoded = yield* Schema.encodeEffect(OrganizationBusinessNameExportRequestSchema)(request).pipe(
    Effect.mapError(unavailable),
  );
  return yield* isOrganizationBusinessNameExportAllowed(transaction, scope, request).pipe(
    withPartyClientSourceRequest({ operation: 'ORGANIZATION_BUSINESS_NAME_EXPORT', payload: encoded }),
  );
});

/**
 * The candidates that match each term on a field Privacy allows them to export. A text match is found first, so
 * Privacy is asked only about Parties that matched; a Party whose field is not allowed is simply not matched. The
 * searched text is never logged or placed in an error.
 */
export const searchSourceParties = Effect.fn('SourcePartySearch.search')(function* search(
  transaction: SearchTransaction,
  scope: OperationalScope,
  input: SourcePartySearchRequest,
): Effect.fn.Return<SourcePartySearchResponse, PartyPersistenceUnavailableError> {
  const candidates = new Map<string, Candidate>();
  for (const candidate of input.candidates) {
    if (candidate.partyRef.tenantId === scope.tenantId && !candidates.has(candidate.partyRef.resourceId)) {
      candidates.set(candidate.partyRef.resourceId, candidate);
    }
  }
  const types = yield* currentCandidateTypes(transaction, scope, [...candidates.keys()]);
  const personIds = input.includePersonProfile
    ? types.filter(({ currentType }) => currentType === 'PERSON').map(({ partyId }) => partyId)
    : [];
  const organizationIds = input.includeOrganizationName
    ? types.filter(({ currentType }) => currentType === 'ORGANIZATION').map(({ partyId }) => partyId)
    : [];
  const now = yield* DateTime.nowAsDate;
  const textMatches = yield* Effect.forEach(
    input.terms,
    (term) =>
      Effect.all(
        {
          organizations: organizationTermMatches(transaction, scope, organizationIds, term, now),
          persons: personTermMatches(transaction, scope, personIds, term, now),
        },
        { concurrency: 1 },
      ),
    { concurrency: 1 },
  );
  const allowed = (
    matched: ReadonlySet<string>,
    check: (
      transaction: SearchTransaction,
      scope: OperationalScope,
      candidate: Candidate,
    ) => Effect.Effect<boolean, PartyPersistenceUnavailableError>,
  ) =>
    Effect.filter(
      [...matched],
      (partyId) => {
        const candidate = candidates.get(partyId);
        return candidate === undefined ? Effect.succeed(false) : check(transaction, scope, candidate);
      },
      { concurrency: 1 },
    ).pipe(Effect.map((partyIds) => new Set(partyIds)));
  const { organizations: allowedOrganizations, persons: allowedPersons } = yield* Effect.all(
    {
      organizations: allowed(
        new Set(textMatches.flatMap(({ organizations }) => organizations)),
        organizationNameAllowed,
      ),
      persons: allowed(new Set(textMatches.flatMap(({ persons }) => persons)), personProfileAllowed),
    },
    { concurrency: 1 },
  );
  return {
    matches: textMatches.map(({ organizations, persons }) =>
      [
        ...persons.filter((partyId) => allowedPersons.has(partyId)),
        ...organizations.filter((partyId) => allowedOrganizations.has(partyId)),
      ].toSorted(),
    ),
  };
});
