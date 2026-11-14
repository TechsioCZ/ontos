import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import { DateTime, Effect } from 'effect';

import type { CustomerListItem } from '../../shared/apis/customer-list.ts';
import { CounterpartyPersistenceUnavailable } from '../../shared/domain/counterparty-errors.ts';
import type { PartyAliasResolutionError } from '../../shared/domain/merge-alias-resolution.ts';
import { resolvePartyAliases } from '../merge/party-alias-resolution.service.ts';
import {
  counterparties,
  counterpartyRolePeriods,
  parties,
  partyContactPoints,
  partyOfficialIdentifiers,
} from '../db/schema.ts';
import type { PartyTransaction } from '../db/types.ts';

type CustomerListTransaction = Pick<PartyTransaction, 'select'>;

export interface CustomerCounterpartyRow {
  readonly archivedAt: Date | null;
  readonly counterpartyId: string;
  readonly createdAt: Date;
  readonly partyId: string;
}

export interface CustomerPartyRow {
  readonly archivedAt: Date | null;
  readonly currentDisplayName: string | null;
  readonly partyId: string;
  readonly revision: number;
}

export interface CustomerIdentifierRow {
  readonly identifierTypeKey: string;
  readonly normalizedValue: string;
  readonly partyId: string;
}

export interface CustomerContactRow {
  readonly city: string | null;
  readonly contactPointType: string;
  readonly displayValue: string | null;
  readonly partyId: string;
}

export interface CustomerListScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

export interface CustomerListQuery {
  readonly includeArchived: boolean;
  readonly limit: number;
}

const unavailable = (cause?: unknown) => {
  const error = new CounterpartyPersistenceUnavailable({
    code: 'counterparty_persistence_unavailable',
    reason: 'Customer list persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const firstByParty = <Row extends { readonly partyId: string }>(
  rows: readonly Row[],
  pick: (row: Row) => string | null,
): ReadonlyMap<string, string> => {
  const values = new Map<string, string>();
  for (const row of rows) {
    const value = pick(row);
    if (value !== null && value.trim().length > 0 && !values.has(row.partyId)) {
      values.set(row.partyId, value.trim());
    }
  }
  return values;
};

const partyRef = (tenantId: string, resourceId: string): CustomerListItem['partyRef'] => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});

const counterpartyRef = (tenantId: string, resourceId: string): CustomerListItem['counterpartyRef'] => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.counterparty',
  tenantId,
});

/**
 * Pure projection of already-scoped rows into list items. A Counterparty whose canonical Party is
 * missing fails closed: the owner FK forbids it, so its absence means the read is inconsistent.
 */
export const assembleCustomerListItems = (
  tenantId: string,
  rows: readonly (CustomerCounterpartyRow & { readonly canonicalPartyId: string })[],
  partyRows: readonly CustomerPartyRow[],
  identifierRows: readonly CustomerIdentifierRow[],
  contactRows: readonly CustomerContactRow[],
): readonly CustomerListItem[] | undefined => {
  const partiesById = new Map(partyRows.map((row) => [row.partyId, row]));
  const icos = firstByParty(
    identifierRows.filter((row) => row.identifierTypeKey === 'ICO'),
    (row) => row.normalizedValue,
  );
  const vatIds = firstByParty(
    identifierRows.filter((row) => row.identifierTypeKey === 'CZ_DIC'),
    (row) => row.normalizedValue,
  );
  const emails = firstByParty(
    contactRows.filter((row) => row.contactPointType === 'EMAIL'),
    (row) => row.displayValue,
  );
  const phones = firstByParty(
    contactRows.filter((row) => row.contactPointType === 'PHONE'),
    (row) => row.displayValue,
  );
  const cities = firstByParty(
    contactRows.filter((row) => row.contactPointType === 'ADDRESS'),
    (row) => row.city,
  );
  const items: CustomerListItem[] = [];
  for (const row of rows) {
    const party = partiesById.get(row.canonicalPartyId);
    if (party === undefined) {
      return undefined;
    }
    items.push({
      city: cities.get(party.partyId) ?? null,
      companyId: icos.get(party.partyId) ?? null,
      counterpartyId: row.counterpartyId,
      counterpartyRef: counterpartyRef(tenantId, row.counterpartyId),
      createdAt: row.createdAt.toISOString(),
      displayName: party.currentDisplayName,
      email: emails.get(party.partyId) ?? null,
      partyId: party.partyId,
      partyRef: partyRef(tenantId, party.partyId),
      partyRevision: party.revision,
      phone: phones.get(party.partyId) ?? null,
      status: row.archivedAt === null && party.archivedAt === null ? 'ACTIVE' : 'ARCHIVED',
      vatId: vatIds.get(party.partyId) ?? null,
    });
  }
  return items;
};

const loadParties = (
  transaction: CustomerListTransaction,
  tenantId: string,
  partyIds: readonly string[],
): Effect.Effect<readonly CustomerPartyRow[], CounterpartyPersistenceUnavailable> =>
  transaction
    .select({
      archivedAt: parties.archivedAt,
      currentDisplayName: parties.currentDisplayName,
      partyId: parties.partyId,
      revision: parties.revision,
    })
    .from(parties)
    .where(and(eq(parties.tenantId, tenantId), inArray(parties.partyId, [...partyIds])))
    .pipe(Effect.mapError(unavailable));

const loadIdentifiers = (
  transaction: CustomerListTransaction,
  tenantId: string,
  partyIds: readonly string[],
  now: Date,
): Effect.Effect<readonly CustomerIdentifierRow[], CounterpartyPersistenceUnavailable> =>
  transaction
    .select({
      identifierTypeKey: partyOfficialIdentifiers.identifierTypeKey,
      normalizedValue: partyOfficialIdentifiers.normalizedValue,
      partyId: partyOfficialIdentifiers.partyId,
    })
    .from(partyOfficialIdentifiers)
    .where(
      and(
        eq(partyOfficialIdentifiers.tenantId, tenantId),
        inArray(partyOfficialIdentifiers.partyId, [...partyIds]),
        eq(partyOfficialIdentifiers.state, 'ACTIVE'),
        eq(partyOfficialIdentifiers.isCurrent, true),
        lte(partyOfficialIdentifiers.validFrom, now),
        or(isNull(partyOfficialIdentifiers.validTo), gt(partyOfficialIdentifiers.validTo, now)),
      ),
    )
    .orderBy(asc(partyOfficialIdentifiers.recordedAt), asc(partyOfficialIdentifiers.officialIdentifierId))
    .pipe(Effect.mapError(unavailable));

const loadContacts = (
  transaction: CustomerListTransaction,
  tenantId: string,
  partyIds: readonly string[],
  now: Date,
): Effect.Effect<readonly CustomerContactRow[], CounterpartyPersistenceUnavailable> =>
  transaction
    .select({
      city: partyContactPoints.city,
      contactPointType: partyContactPoints.contactPointType,
      displayValue: partyContactPoints.displayValue,
      partyId: partyContactPoints.partyId,
    })
    .from(partyContactPoints)
    .where(
      and(
        eq(partyContactPoints.tenantId, tenantId),
        inArray(partyContactPoints.partyId, [...partyIds]),
        ne(partyContactPoints.privacyClassification, 'PERSONAL'),
        eq(partyContactPoints.state, 'ACTIVE'),
        eq(partyContactPoints.isCurrent, true),
        lte(partyContactPoints.validFrom, now),
        or(isNull(partyContactPoints.validTo), gt(partyContactPoints.validTo, now)),
      ),
    )
    .orderBy(
      desc(partyContactPoints.preferred),
      asc(partyContactPoints.recordedAt),
      asc(partyContactPoints.contactPointId),
    )
    .pipe(Effect.mapError(unavailable));

/**
 * Lists Counterparties of the trusted Legal Entity that hold a CUSTOMER role period effective now,
 * resolved to their canonical Party. Contact Points classified PERSONAL never leave this read.
 */
export const listCustomerRecords = Effect.fn('CustomerListPersistenceService.listCustomerRecords')(
  function* listCustomers(
    transaction: CustomerListTransaction,
    scope: CustomerListScope,
    query: CustomerListQuery,
    resolveCanonicalPartyIds: (
      partyIds: readonly string[],
    ) => Effect.Effect<ReadonlyMap<string, string>, PartyAliasResolutionError> = (partyIds) =>
      resolvePartyAliases(transaction, scope.tenantId, partyIds),
  ) {
    const now = yield* DateTime.nowAsDate;
    const joinedRows: readonly CustomerCounterpartyRow[] = yield* transaction
      .select({
        archivedAt: counterparties.archivedAt,
        counterpartyId: counterparties.counterpartyId,
        createdAt: counterparties.createdAt,
        partyId: counterparties.partyId,
      })
      .from(counterparties)
      .innerJoin(
        counterpartyRolePeriods,
        and(
          eq(counterpartyRolePeriods.tenantId, counterparties.tenantId),
          eq(counterpartyRolePeriods.legalEntityId, counterparties.legalEntityId),
          eq(counterpartyRolePeriods.counterpartyId, counterparties.counterpartyId),
        ),
      )
      .where(
        and(
          eq(counterparties.tenantId, scope.tenantId),
          eq(counterparties.legalEntityId, scope.legalEntityId),
          query.includeArchived ? undefined : isNull(counterparties.archivedAt),
          eq(counterpartyRolePeriods.roleType, 'CUSTOMER'),
          eq(counterpartyRolePeriods.state, 'ACTIVE'),
          lte(counterpartyRolePeriods.validFrom, now),
          or(isNull(counterpartyRolePeriods.validTo), gt(counterpartyRolePeriods.validTo, now)),
        ),
      )
      .orderBy(asc(counterparties.createdAt), asc(counterparties.counterpartyId))
      .limit(query.limit)
      .pipe(Effect.mapError(unavailable));
    // Non-overlapping CUSTOMER periods admit one current period, but stay correct if that ever changes.
    const counterpartyRows = [...new Map(joinedRows.map((row) => [row.counterpartyId, row])).values()];
    if (counterpartyRows.length === 0) {
      return [];
    }
    // One set-based alias resolution for the whole page (was two queries per customer).
    const canonical = yield* resolveCanonicalPartyIds(counterpartyRows.map((row) => row.partyId)).pipe(
      Effect.mapError(unavailable),
    );
    const rows = counterpartyRows.flatMap((row) => {
      const canonicalPartyId = canonical.get(row.partyId);
      return canonicalPartyId === undefined ? [] : [{ ...row, canonicalPartyId }];
    });
    if (rows.length !== counterpartyRows.length) {
      return yield* unavailable();
    }
    const partyIds = [...new Set(rows.map(({ canonicalPartyId }) => canonicalPartyId))];
    // One transaction connection: the three reads stay sequential (concurrency 1).
    const [partyRows, identifierRows, contactRows] = yield* Effect.all(
      [
        loadParties(transaction, scope.tenantId, partyIds),
        loadIdentifiers(transaction, scope.tenantId, partyIds, now),
        loadContacts(transaction, scope.tenantId, partyIds, now),
      ],
      { concurrency: 1 },
    );
    const items = assembleCustomerListItems(scope.tenantId, rows, partyRows, identifierRows, contactRows);
    if (items === undefined) {
      return yield* unavailable();
    }
    return items;
  },
);
