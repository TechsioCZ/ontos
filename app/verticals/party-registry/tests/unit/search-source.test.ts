import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableName } from 'drizzle-orm';
import type { AnyColumn, Query, SQL, Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DateTime, Effect } from 'effect';
import type {
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotService,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import { makePartySearchProjectionSource } from '../../src/services/party-search-projection-source.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '20000000-0000-4000-8000-000000000001';
const aliasId = '20000000-0000-4000-8000-000000000002';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const counterpartyId = '40000000-0000-4000-8000-000000000001';
const context: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'claim',
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: 'party.registry',
  tenantId,
  tenantSequenceNo: 3n,
  topic: 'party.registry.party-updated.v1',
  workerKey: 'party.registry.project-party-updated-to-search',
};
const from = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'));
const ref = (resourceId: string) => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});

const harness = (
  rows: Readonly<Record<string, readonly Record<string, string | boolean | Date | null>[]>>,
  legalEntityIds: readonly string[] = [legalEntityId],
) => {
  const columns: Record<string, readonly string[]> = {};
  const filters: Record<string, Query> = {};
  const scopes: (string | undefined)[] = [];
  // SAFETY: this database-boundary fake implements the select/from/where chain used by the owner source and returns fixture rows matching its selected columns.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- Drizzle's full database executor is intentionally narrowed to this exercised read-only database-boundary fake.
  const executor = {
    select: (selection: Record<string, AnyColumn>) => ({
      from: (table: Table) => {
        const name = getTableName(table);
        columns[name] = Object.keys(selection);
        return {
          where: (condition: SQL) => {
            filters[name] = new PgDialect().sqlToQuery(condition);
            return Promise.resolve(rows[name] ?? []);
          },
        };
      },
    }),
  } as unknown as CoreSearchSnapshotReadExecutor;
  const snapshot: CoreSearchWorkerSnapshotService = {
    read: (_context, readSnapshot) =>
      readSnapshot({
        eventWatermark: '99',
        forLegalEntity: (id, read) => {
          scopes.push(id);
          return read(executor);
        },
        legalEntityIds,
        projectionVersion: '9',
        tenant: (read) => {
          scopes.push(undefined);
          return read(executor);
        },
        tenantId,
      }),
  };
  return { columns, filters, scopes, source: makePartySearchProjectionSource(snapshot) };
};

test('canonical snapshot preserves alias identity and legal-entity Counterparty context', () =>
  Effect.runPromise(
    Effect.gen(function* canonicalAliasSnapshot() {
      const { source } = harness({
        counterparties: [{ counterpartyId, legalEntityId, partyId: aliasId, tenantId }],
        counterparty_role_periods: [
          {
            counterpartyId,
            legalEntityId,
            role: 'CUSTOMER',
            state: 'ACTIVE',
            tenantId,
            validFrom: from,
            validTo: null,
          },
        ],
        parties: [
          { archivedAt: null, displayName: 'Canonical', partyId, tenantId },
          { archivedAt: from, displayName: 'Former name', partyId: aliasId, tenantId },
        ],
        party_aliases: [{ aliasPartyId: aliasId, canonicalPartyId: partyId, tenantId }],
        party_contact_points: [],
        party_official_identifiers: [
          {
            isCurrent: true,
            partyId,
            state: 'ACTIVE',
            tenantId,
            validFrom: from,
            validTo: null,
            value: '27074358',
          },
        ],
      });
      const result = yield* source.load(context, { partyId: aliasId });
      assert.deepEqual(result, {
        counterparties: [
          {
            legalEntityId,
            partyRef: ref(partyId),
            ref: { ...ref(counterpartyId), resourceType: 'party.registry.counterparty' },
            rolePeriods: [{ role: 'CUSTOMER', state: 'ACTIVE', validFrom: from.toISOString() }],
            storedPartyRef: ref(aliasId),
          },
        ],
        parties: [
          {
            aliases: [
              { contacts: [], displayName: 'Former name', identifiers: [], ref: ref(aliasId) },
            ],
            archived: false,
            contacts: [],
            displayName: 'Canonical',
            identifiers: [{ state: 'ACTIVE', validFrom: from.toISOString(), value: '27074358' }],
            ref: ref(partyId),
          },
        ],
        projectionVersion: '9',
        removedRefs: [ref(aliasId)],
        tenantId,
      });
    }),
  ));

test('source exposes only current public email and phone search evidence, never ADDRESS or raw contact fields', () =>
  Effect.runPromise(
    Effect.gen(function* privateSearchEvidence() {
      const contact = {
        isCurrent: true,
        partyId,
        privacy: 'PUBLIC',
        state: 'ACTIVE',
        tenantId,
        type: 'EMAIL',
        validFrom: from,
        validTo: null,
        value: 'public@example.test',
      };
      const { source, columns, filters } = harness({
        parties: [{ archivedAt: null, displayName: null, partyId, tenantId }],
        party_contact_points: [
          contact,
          {
            ...contact,
            type: 'PHONE',
            validFrom: DateTime.toDateUtc(DateTime.makeUnsafe('2027-01-01T00:00:00.000Z')),
            value: '+420123456789',
          },
          { ...contact, privacy: 'PERSONAL', value: 'personal@example.test' },
          { ...contact, privacy: 'BUSINESS_SENSITIVE', value: 'sensitive@example.test' },
          { ...contact, state: 'ENDED', value: 'ended@example.test' },
          { ...contact, isCurrent: false, value: 'superseded@example.test' },
          { ...contact, type: 'ADDRESS', value: 'Private road' },
        ],
      });
      const result = yield* source.load(context, { partyId });
      assert.deepEqual(result.parties[0]?.contacts, [
        {
          privacy: 'PUBLIC',
          state: 'ACTIVE',
          type: 'EMAIL',
          validFrom: from.toISOString(),
          value: 'public@example.test',
        },
        {
          privacy: 'PUBLIC',
          state: 'ACTIVE',
          type: 'PHONE',
          validFrom: '2027-01-01T00:00:00.000Z',
          value: '+420123456789',
        },
      ]);
      assert.equal(result.parties[0]?.displayName, null);
      assert.deepEqual(filters['party_contact_points']?.params, [
        tenantId,
        partyId,
        'EMAIL',
        'PHONE',
        'PUBLIC',
        'ACTIVE',
        true,
      ]);
      assert.match(filters['party_contact_points']?.sql ?? '', /privacy_classification/u);
      assert.deepEqual(
        columns['party_contact_points']?.toSorted(),
        [
          'partyId',
          'tenantId',
          'value',
          'type',
          'privacy',
          'state',
          'isCurrent',
          'validFrom',
          'validTo',
        ].toSorted(),
      );
    }),
  ));

test('missing Party and Counterparty targets produce explicit versioned tombstone refs', () =>
  Effect.runPromise(
    Effect.gen(function* missingTargetTombstones() {
      const { source } = harness({});
      const party = yield* source.load(context, { partyId });
      const counterparty = yield* source.load(context, { counterpartyId });
      assert.deepEqual(party, {
        counterparties: [],
        parties: [],
        projectionVersion: '9',
        removedRefs: [ref(partyId)],
        tenantId,
      });
      assert.deepEqual(counterparty.removedRefs, [
        { ...ref(counterpartyId), resourceType: 'party.registry.counterparty' },
      ]);
    }),
  ));

test('full rebuild reads each Core-enumerated legal entity in the same snapshot and keeps distinct Counterparties', () =>
  Effect.runPromise(
    Effect.gen(function* rebuildSnapshot() {
      const secondLegalEntityId = '30000000-0000-4000-8000-000000000002';
      const secondCounterpartyId = '40000000-0000-4000-8000-000000000002';
      const { source, scopes } = harness(
        {
          counterparties: [
            { counterpartyId, legalEntityId, partyId, tenantId },
            {
              counterpartyId: secondCounterpartyId,
              legalEntityId: secondLegalEntityId,
              partyId,
              tenantId,
            },
          ],
          parties: [{ archivedAt: from, displayName: 'Shared Party', partyId, tenantId }],
        },
        [legalEntityId, secondLegalEntityId],
      );
      const result = yield* source.load(context, { rebuild: true });
      assert.deepEqual(scopes, [undefined, legalEntityId, secondLegalEntityId, undefined]);
      assert.deepEqual(
        result.counterparties.map((row) => row.ref.resourceId),
        [counterpartyId, secondCounterpartyId],
      );
      assert.equal(result.parties[0]?.archived, true);
      assert.equal(result.projectionVersion, '9');
    }),
  ));

test('Counterparty-only refresh emits only its canonical family and selected Counterparty', () =>
  Effect.runPromise(
    Effect.gen(function* targetedCounterpartySnapshot() {
      const otherId = '20000000-0000-4000-8000-000000000009';
      const { source } = harness({
        counterparties: [
          { counterpartyId, legalEntityId, partyId, tenantId },
          {
            counterpartyId: '40000000-0000-4000-8000-000000000009',
            legalEntityId,
            partyId: otherId,
            tenantId,
          },
        ],
        parties: [
          { archivedAt: null, displayName: 'Selected', partyId, tenantId },
          { archivedAt: null, displayName: 'Unrelated', partyId: otherId, tenantId },
        ],
      });
      const result = yield* source.load(context, { counterpartyId });
      assert.deepEqual(
        result.parties.map((party) => party.ref.resourceId),
        [partyId],
      );
      assert.deepEqual(
        result.counterparties.map((row) => row.ref.resourceId),
        [counterpartyId],
      );
    }),
  ));

test('alias cycles and cross-tenant source rows fail closed with sanitized typed failures', () =>
  Effect.runPromise(
    Effect.gen(function* rejectedSourceSnapshot() {
      for (const rows of [
        {
          parties: [{ archivedAt: null, displayName: 'A', partyId, tenantId }],
          party_aliases: [{ aliasPartyId: partyId, canonicalPartyId: partyId, tenantId }],
        },
        {
          parties: [
            { archivedAt: null, displayName: 'Secret name', partyId, tenantId: 'foreign-tenant' },
          ],
        },
      ]) {
        const { source } = harness(rows);
        const outcome = yield* source.load(context, { rebuild: true }).pipe(Effect.result);
        assert.equal(outcome._tag, 'Failure');
        if (outcome._tag === 'Failure') {
          assert.equal(outcome.failure._tag, 'PartySearchProjectionUnavailable');
          assert.doesNotMatch(outcome.failure.reason, /Secret name|foreign-tenant/u);
        }
      }
    }),
  ));
