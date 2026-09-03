import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import {
  makeCoreSearchQueryRuntime,
  makeCoreSearchIngestion,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchProjectionDocument, OutboxWorkerHandlerContext } from '@app/core-runtime';
import {
  buildPartySearchDocuments,
  makePartySearchProjector,
} from '../../src/services/party-search-projection.service.ts';
import type { PartySearchSourceSnapshot } from '../../src/services/party-search-projection.service.ts';
import { PartySearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';
import { makePartySearchProjectionGateway } from '../../src/search/parties.provider.ts';
import { normalizeCounterpartySearchHits } from '../../shared/domain/search-semantics.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: 'party-1',
  resourceType: 'party.registry.party' as const,
  tenantId,
};
const snapshot: PartySearchSourceSnapshot = {
  counterparties: [],
  parties: [
    {
      aliases: [],
      archived: false,
      contacts: [
        {
          privacy: 'PUBLIC',
          state: 'ACTIVE',
          type: 'EMAIL',
          validFrom: '2026-01-01T00:00:00.000Z',
          value: 'public@example.test',
        },
        {
          privacy: 'PERSONAL',
          state: 'ACTIVE',
          type: 'EMAIL',
          validFrom: '2026-01-01T00:00:00.000Z',
          value: 'private@example.test',
        },
        {
          privacy: 'PUBLIC',
          state: 'ENDED',
          type: 'PHONE',
          validFrom: '2026-01-01T00:00:00.000Z',
          value: '+420123456789',
        },
      ],
      displayName: 'ACME',
      identifiers: [
        {
          state: 'ACTIVE',
          validFrom: '2026-01-01T00:00:00.000Z',
          value: '12345678',
        },
      ],
      ref: partyRef,
    },
  ],
  projectionVersion: '7',
  removedRefs: [],
  tenantId,
};
test('post-commit projection makes only active permission-safe identity evidence searchable', () =>
  Effect.runPromise(
    Effect.gen(function* testScenario() {
      const documents = yield* buildPartySearchDocuments(snapshot);
      const store = makeInMemoryCoreSearchProjectionStore();
      yield* Effect.forEach((document: CoreSearchProjectionDocument) =>
        store.apply({
          document,
          kind: 'upsert',
        }),
      )(documents);
      const search = makeCoreSearchQueryRuntime(store);
      const query = (value: string) =>
        search.search({
          effectiveAt: '2026-09-03T00:00:00.000Z',
          includeArchived: false,
          moduleId: 'party.registry',
          query: value,
          resourceType: 'party.registry.party',
          tenantId,
        });
      const publicHits = yield* query('public@example.test');
      const identifierHits = yield* query('12345678');
      assert.equal(publicHits.length, 1);
      assert.equal(identifierHits.length, 1);
      assert.deepEqual(yield* query('private@example.test'), []);
      assert.deepEqual(yield* query('+420123456789'), []);
      assert.deepEqual(publicHits, [
        { archived: false, facets: [], metadata: [], ref: partyRef, title: 'ACME' },
      ]);
    }),
  ));
test('aliases collapse to canonical identity and only alias-only evidence labels the match', () =>
  Effect.runPromise(
    Effect.gen(function* testScenario() {
      const [party] = snapshot.parties;
      assert.ok(party);
      const store = makeInMemoryCoreSearchProjectionStore();
      const documents = yield* buildPartySearchDocuments({
        ...snapshot,
        parties: [
          {
            ...party,
            aliases: [
              {
                ...party,
                displayName: 'Old Company',
                ref: {
                  ...partyRef,
                  resourceId: 'absorbed',
                },
              },
            ],
          },
        ],
      });
      yield* Effect.forEach((document: CoreSearchProjectionDocument) =>
        store.apply({
          document,
          kind: 'upsert',
        }),
      )(documents);
      const query = (value: string) =>
        makeCoreSearchQueryRuntime(store).search({
          includeArchived: false,
          moduleId: 'party.registry',
          query: value,
          resourceType: 'party.registry.party',
          tenantId,
        });
      const alias = yield* query('Old Company');
      assert.equal(alias.length, 1);
      assert.deepEqual(alias[0]?.ref, partyRef);
      assert.equal(alias[0]?.matchedRef?.resourceId, 'absorbed');
      const canonicalHits = yield* query('ACME');
      assert.equal(canonicalHits[0]?.matchedRef, undefined);
    }),
  ));
const context: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'claim',
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: 'party.registry',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'party.registry.party-updated.v1',
  workerKey: 'party.registry.project-party-updated-to-search',
};
test('snapshot-generation replay is idempotent, archive/unarchive refreshes and older delivery cannot resurrect a tombstone', () =>
  Effect.runPromise(
    Effect.gen(function* testScenario() {
      const store = makeInMemoryCoreSearchProjectionStore();
      let current = snapshot;
      const projector = makePartySearchProjector(
        {
          load: () => Effect.succeed(current),
        },
        makeCoreSearchIngestion(store),
        store,
      );
      const deliver = () =>
        projector.project(context, {
          partyId: partyRef.resourceId,
        });
      const query = (includeArchived = false) =>
        makeCoreSearchQueryRuntime(store).search({
          includeArchived,
          moduleId: 'party.registry',
          query: 'ACME',
          resourceType: 'party.registry.party',
          tenantId,
        });
      yield* deliver();
      yield* deliver();
      const replayHits = yield* query();
      assert.equal(replayHits.length, 1);
      current = {
        ...snapshot,
        parties: snapshot.parties.map((party) => ({
          ...party,
          archived: true,
        })),
        projectionVersion: '8',
      };
      yield* deliver();
      assert.deepEqual(yield* query(), []);
      const archivedHits = yield* query(true);
      assert.equal(archivedHits[0]?.archived, true);
      current = {
        ...snapshot,
        projectionVersion: '9',
      };
      yield* deliver();
      const unarchivedHits = yield* query();
      assert.equal(unarchivedHits.length, 1);
      current = {
        ...snapshot,
        parties: [],
        projectionVersion: '10',
        removedRefs: [partyRef],
      };
      yield* deliver();
      current = snapshot;
      yield* deliver();
      assert.deepEqual(yield* query(true), []);
    }),
  ));
test('future-ended contact disappears at its period boundary without another lifecycle message', () =>
  Effect.runPromise(
    Effect.gen(function* testScenario() {
      const [party] = snapshot.parties;
      assert.ok(party);
      const store = makeInMemoryCoreSearchProjectionStore();
      const documents = yield* buildPartySearchDocuments({
        ...snapshot,
        parties: [
          {
            ...party,
            contacts: [
              {
                privacy: 'PUBLIC',
                state: 'ACTIVE',
                type: 'EMAIL',
                validFrom: '2026-01-01T00:00:00.000Z',
                validTo: '2026-09-04T00:00:00.000Z',
                value: 'timed@example.test',
              },
            ],
          },
        ],
      });
      yield* Effect.forEach((document: CoreSearchProjectionDocument) =>
        store.apply({
          document,
          kind: 'upsert',
        }),
      )(documents);
      const query = (effectiveAt: string) =>
        makeCoreSearchQueryRuntime(store).search({
          effectiveAt,
          includeArchived: false,
          moduleId: 'party.registry',
          query: 'timed@example.test',
          resourceType: 'party.registry.party',
          tenantId,
        });
      const currentHits = yield* query('2026-09-03T00:00:00.000Z');
      assert.equal(currentHits.length, 1);
      assert.deepEqual(yield* query('2026-09-04T00:00:00.000Z'), []);
    }),
  ));
test('Counterparty identity survives aliases, current-role expiry and canonical-party collisions', () =>
  Effect.runPromise(
    Effect.gen(function* testScenario() {
      const legalEntityId = '20000000-0000-4000-8000-000000000002';
      const [party] = snapshot.parties;
      assert.ok(party);
      const aliasRef = {
        ...partyRef,
        resourceId: 'absorbed',
      };
      const store = makeInMemoryCoreSearchProjectionStore();
      const documents = yield* buildPartySearchDocuments({
        ...snapshot,
        counterparties: ['cp-1', 'cp-2'].map((resourceId) => ({
          legalEntityId,
          partyRef,
          ref: {
            moduleId: 'party.registry',
            resourceId,
            resourceType: 'party.registry.counterparty',
            tenantId,
          },
          rolePeriods: [
            {
              role: 'CUSTOMER',
              state: 'ACTIVE',
              validFrom: '2026-01-01T00:00:00.000Z',
              validTo: '2026-10-01T00:00:00.000Z',
            },
          ],
          storedPartyRef: aliasRef,
        })),
        parties: [
          {
            ...party,
            aliases: [
              {
                ...party,
                displayName: 'Old Company',
                ref: aliasRef,
              },
            ],
          },
        ],
      });
      yield* Effect.forEach((document: CoreSearchProjectionDocument) =>
        store.apply({
          document,
          kind: 'upsert',
        }),
      )(documents);
      const gateway = makePartySearchProjectionGateway(makeCoreSearchQueryRuntime(store));
      const input = {
        effectiveAt: '2026-09-03T00:00:00.000Z',
        includeArchived: false,
        legalEntityId,
        query: 'Old Company',
        role: 'CUSTOMER' as const,
        tenantId,
      };
      const hits = yield* gateway.searchCounterparties(input);
      assert.equal(hits.length, 2);
      assert.deepEqual(
        hits.map((hit) => hit.counterpartyRef.resourceId),
        ['cp-1', 'cp-2'],
      );
      const normalized = normalizeCounterpartySearchHits(input, hits);
      assert.equal(normalized._tag, 'SearchResults');
      if (normalized._tag === 'SearchResults') {
        assert.equal(
          normalized.items[0]?.collision?.kind,
          'CANONICAL_PARTY_COUNTERPARTY_COLLISION',
        );
        assert.equal(normalized.items[0]?.party.matchedViaAlias, true);
      }
      assert.deepEqual(
        yield* gateway.searchCounterparties({
          ...input,
          effectiveAt: '2026-10-01T00:00:00.000Z',
        }),
        [],
      );
    }),
  ));
test('shared public contact returns multiple Parties without uniqueness or matching authority', () =>
  Effect.runPromise(
    Effect.gen(function* testScenario() {
      const store = makeInMemoryCoreSearchProjectionStore();
      const [party] = snapshot.parties;
      assert.ok(party);
      const documents = yield* buildPartySearchDocuments({
        ...snapshot,
        parties: [
          party,
          {
            ...party,
            ref: {
              ...partyRef,
              resourceId: 'party-2',
            },
          },
        ],
      });
      yield* Effect.forEach((document: CoreSearchProjectionDocument) =>
        store.apply({
          document,
          kind: 'upsert',
        }),
      )(documents);
      const hits = yield* makeCoreSearchQueryRuntime(store).search({
        includeArchived: false,
        moduleId: 'party.registry',
        query: 'public@example.test',
        resourceType: 'party.registry.party',
        tenantId,
      });
      assert.deepEqual(
        hits.map((hit) => hit.ref.resourceId),
        ['party-1', 'party-2'],
      );
    }),
  ));
test('rebuild reconciles omitted documents and preserves tombstones against stale lifecycle delivery', () =>
  Effect.runPromise(
    Effect.gen(function* testScenario() {
      const store = makeInMemoryCoreSearchProjectionStore();
      let current = snapshot;
      const projector = makePartySearchProjector(
        {
          load: () => Effect.succeed(current),
        },
        makeCoreSearchIngestion(store),
        store,
      );
      yield* projector.project(context, {
        partyId: 'party-1',
      });
      current = {
        ...snapshot,
        parties: [],
        projectionVersion: '8',
      };
      yield* projector.project(context, {
        rebuild: true,
      });
      yield* projector.project(context, {
        rebuild: true,
      });
      current = snapshot;
      yield* projector.project(context, {
        partyId: 'party-1',
      });
      assert.deepEqual(
        yield* makeCoreSearchQueryRuntime(store).search({
          includeArchived: true,
          moduleId: 'party.registry',
          query: 'ACME',
          resourceType: 'party.registry.party',
          tenantId,
        }),
        [],
      );
    }),
  ));
test('source failure is sanitized and leaves previously searchable state intact for retry', () =>
  Effect.runPromise(
    Effect.gen(function* testScenario() {
      const store = makeInMemoryCoreSearchProjectionStore();
      let fail = false;
      const projector = makePartySearchProjector(
        {
          load: () =>
            fail
              ? Effect.fail(
                  new PartySearchProjectionUnavailable({
                    code: 'party_search_projection_unavailable',
                    reason: 'Projection temporarily unavailable',
                  }),
                )
              : Effect.succeed(snapshot),
        },
        makeCoreSearchIngestion(store),
        store,
      );
      yield* projector.project(context, {
        partyId: 'party-1',
      });
      fail = true;
      const failure = yield* Effect.exit(
        projector.project(context, {
          partyId: 'party-1',
        }),
      );
      const priorHits = yield* makeCoreSearchQueryRuntime(store).search({
        includeArchived: false,
        moduleId: 'party.registry',
        query: 'ACME',
        resourceType: 'party.registry.party',
        tenantId,
      });
      assert.equal(failure._tag, 'Failure');
      assert.equal(priorHits.length, 1);
    }),
  ));
test('zero-length cancelled periods are never searchable and do not poison projection delivery', () =>
  Effect.runPromise(
    Effect.gen(function* testScenario() {
      const [party] = snapshot.parties;
      assert.ok(party);
      const result = yield* Effect.exit(
        buildPartySearchDocuments({
          ...snapshot,
          counterparties: [
            {
              legalEntityId: '20000000-0000-4000-8000-000000000002',
              partyRef,
              ref: {
                moduleId: 'party.registry',
                resourceId: 'cp-cancelled',
                resourceType: 'party.registry.counterparty',
                tenantId,
              },
              rolePeriods: [
                {
                  role: 'CUSTOMER',
                  state: 'ACTIVE',
                  validFrom: '2026-09-03T00:00:00.000Z',
                  validTo: '2026-09-03T00:00:00.000Z',
                },
              ],
              storedPartyRef: partyRef,
            },
          ],
          parties: [
            {
              ...party,
              identifiers: [
                {
                  state: 'ACTIVE',
                  validFrom: '2026-09-03T00:00:00.000Z',
                  validTo: '2026-09-03T00:00:00.000Z',
                  value: 'cancelled',
                },
              ],
            },
          ],
        }),
      );
      assert.equal(result._tag, 'Success');
      if (result._tag === 'Success') {
        assert.deepEqual(
          result.value[0]?.temporalSearchableText?.filter((entry) => entry.value === 'cancelled'),
          [],
        );
        assert.deepEqual(result.value[1]?.temporalFacets, []);
      }
    }),
  ));
test('projection generation is independent of an out-of-order business event sequence', () =>
  Effect.runPromise(
    Effect.gen(function* testScenario() {
      const store = makeInMemoryCoreSearchProjectionStore();
      const projector = makePartySearchProjector(
        {
          load: () =>
            Effect.succeed({
              ...snapshot,
              projectionVersion: '1',
            }),
        },
        makeCoreSearchIngestion(store),
        store,
      );
      yield* projector.project(
        {
          ...context,
          tenantSequenceNo: 999n,
        },
        {
          partyId: 'party-1',
        },
      );
      const hits = yield* makeCoreSearchQueryRuntime(store).search({
        includeArchived: false,
        moduleId: 'party.registry',
        query: 'ACME',
        resourceType: 'party.registry.party',
        tenantId,
      });
      assert.equal(hits.length, 1);
    }),
  ));
test('correction and identifier/contact changes replace obsolete evidence instead of accumulating history', () =>
  Effect.runPromise(
    Effect.gen(function* testScenario() {
      const [party] = snapshot.parties;
      assert.ok(party);
      const store = makeInMemoryCoreSearchProjectionStore();
      let current = snapshot;
      const projector = makePartySearchProjector(
        {
          load: () => Effect.succeed(current),
        },
        makeCoreSearchIngestion(store),
        store,
      );
      yield* projector.project(context, {
        partyId: 'party-1',
      });
      current = {
        ...snapshot,
        parties: [
          {
            ...party,
            contacts: [],
            displayName: 'Corrected Company',
            identifiers: [
              {
                state: 'SUPERSEDED',
                validFrom: '2026-01-01T00:00:00.000Z',
                value: '12345678',
              },
            ],
          },
        ],
        projectionVersion: '8',
      };
      yield* projector.project(context, {
        partyId: 'party-1',
      });
      const query = (value: string) =>
        makeCoreSearchQueryRuntime(store).search({
          includeArchived: false,
          moduleId: 'party.registry',
          query: value,
          resourceType: 'party.registry.party',
          tenantId,
        });
      assert.deepEqual(yield* query('ACME'), []);
      assert.deepEqual(yield* query('12345678'), []);
      assert.deepEqual(yield* query('public@example.test'), []);
      const corrected = yield* query('Corrected Company');
      assert.equal(corrected.length, 1);
    }),
  ));
test('a complete empty rebuild also rejects delayed evidence for a never-before-indexed Party', () =>
  Effect.runPromise(
    Effect.gen(function* testScenario() {
      const store = makeInMemoryCoreSearchProjectionStore();
      let current: PartySearchSourceSnapshot = {
        ...snapshot,
        parties: [],
        projectionVersion: '8',
      };
      const projector = makePartySearchProjector(
        {
          load: () => Effect.succeed(current),
        },
        makeCoreSearchIngestion(store),
        store,
      );
      yield* projector.project(context, {
        rebuild: true,
      });
      current = snapshot;
      yield* projector.project(context, {
        partyId: 'party-1',
      });
      const hits = yield* makeCoreSearchQueryRuntime(store).search({
        includeArchived: true,
        moduleId: 'party.registry',
        query: 'ACME',
        resourceType: 'party.registry.party',
        tenantId,
      });
      assert.deepEqual(hits, []);
    }),
  ));
