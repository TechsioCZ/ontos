import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { Effect, Exit, Match, Predicate } from 'effect';
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
it.effect(
  'post-commit projection makes only active permission-safe identity evidence searchable',
  () =>
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
      expect(publicHits.length).toBe(1);
      expect(identifierHits.length).toBe(1);
      expect(yield* query('private@example.test')).toEqual([]);
      expect(yield* query('+420123456789')).toEqual([]);
      expect(publicHits).toEqual([
        { archived: false, facets: [], metadata: [], ref: partyRef, title: 'ACME' },
      ]);
    }),
);
it.effect(
  'aliases collapse to canonical identity and only alias-only evidence labels the match',
  () =>
    Effect.gen(function* testScenario() {
      const [party] = snapshot.parties;
      expect(party).toBeTruthy();
      if (party === undefined) {
        throw new Error('Expected value to be present');
      }
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
      expect(alias.length).toBe(1);
      expect(alias[0]?.ref).toEqual(partyRef);
      expect(alias[0]?.matchedRef?.resourceId).toBe('absorbed');
      const canonicalHits = yield* query('ACME');
      expect(canonicalHits[0]?.matchedRef).toBe(undefined);
    }),
);
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
it.effect(
  'snapshot-generation replay is idempotent, archive/unarchive refreshes and older delivery cannot resurrect a tombstone',
  () =>
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
      expect(replayHits.length).toBe(1);
      current = {
        ...snapshot,
        parties: snapshot.parties.map((party) => ({
          ...party,
          archived: true,
        })),
        projectionVersion: '8',
      };
      yield* deliver();
      expect(yield* query()).toEqual([]);
      const archivedHits = yield* query(true);
      expect(archivedHits[0]?.archived).toBe(true);
      current = {
        ...snapshot,
        projectionVersion: '9',
      };
      yield* deliver();
      const unarchivedHits = yield* query();
      expect(unarchivedHits.length).toBe(1);
      current = {
        ...snapshot,
        parties: [],
        projectionVersion: '10',
        removedRefs: [partyRef],
      };
      yield* deliver();
      current = snapshot;
      yield* deliver();
      expect(yield* query(true)).toEqual([]);
    }),
);
it.effect(
  'future-ended contact disappears at its period boundary without another lifecycle message',
  () =>
    Effect.gen(function* testScenario() {
      const [party] = snapshot.parties;
      expect(party).toBeTruthy();
      if (party === undefined) {
        throw new Error('Expected value to be present');
      }
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
      expect(currentHits.length).toBe(1);
      expect(yield* query('2026-09-04T00:00:00.000Z')).toEqual([]);
    }),
);
it.effect(
  'Counterparty identity survives aliases, current-role expiry and canonical-party collisions',
  () =>
    Effect.gen(function* testScenario() {
      const legalEntityId = '20000000-0000-4000-8000-000000000002';
      const [party] = snapshot.parties;
      expect(party).toBeTruthy();
      if (party === undefined) {
        throw new Error('Expected value to be present');
      }
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
      expect(hits.length).toBe(2);
      expect(hits.map((hit) => hit.counterpartyRef.resourceId)).toEqual(['cp-1', 'cp-2']);
      const normalized = normalizeCounterpartySearchHits(input, hits);
      const normalizedItems = Match.value(normalized).pipe(
        Match.tag('SearchResults', ({ items }) => items),
        Match.tag('SearchProjectionViolation', ({ reason }) =>
          expect.unreachable(`Expected normalized search results: ${reason}`),
        ),
        Match.exhaustive,
      );
      expect(normalizedItems[0]?.collision?.kind).toBe('CANONICAL_PARTY_COUNTERPARTY_COLLISION');
      expect(normalizedItems[0]?.party.matchedViaAlias).toBe(true);
      expect(
        yield* gateway.searchCounterparties({
          ...input,
          effectiveAt: '2026-10-01T00:00:00.000Z',
        }),
      ).toEqual([]);
    }),
);
it.effect(
  'shared public contact returns multiple Parties without uniqueness or matching authority',
  () =>
    Effect.gen(function* testScenario() {
      yield* TestClock.setTime(Date.parse('2026-09-03T00:00:00.000Z'));
      const store = makeInMemoryCoreSearchProjectionStore();
      const [party] = snapshot.parties;
      expect(party).toBeTruthy();
      if (party === undefined) {
        throw new Error('Expected value to be present');
      }
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
      expect(hits.map((hit) => hit.ref.resourceId)).toEqual(['party-1', 'party-2']);
    }),
);
it.effect(
  'rebuild reconciles omitted documents and preserves tombstones against stale lifecycle delivery',
  () =>
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
      expect(
        yield* makeCoreSearchQueryRuntime(store).search({
          includeArchived: true,
          moduleId: 'party.registry',
          query: 'ACME',
          resourceType: 'party.registry.party',
          tenantId,
        }),
      ).toEqual([]);
    }),
);
it.effect(
  'source failure is sanitized and leaves previously searchable state intact for retry',
  () =>
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
      expect(Predicate.isTagged(failure, 'Failure')).toBeTruthy();
      expect(priorHits.length).toBe(1);
    }),
);
it.effect(
  'zero-length cancelled periods are never searchable and do not poison projection delivery',
  () =>
    Effect.gen(function* testScenario() {
      const [party] = snapshot.parties;
      expect(party).toBeTruthy();
      if (party === undefined) {
        throw new Error('Expected value to be present');
      }
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
      expect(Exit.isSuccess(result)).toBeTruthy();
      if (!Exit.isSuccess(result)) {
        throw new Error('Expected value to be present');
      }
      expect(
        result.value[0]?.temporalSearchableText?.filter((entry) => entry.value === 'cancelled'),
      ).toEqual([]);
      expect(result.value[1]?.temporalFacets).toEqual([]);
    }),
);
it.effect('projection generation is independent of an out-of-order business event sequence', () =>
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
    expect(hits.length).toBe(1);
  }),
);
it.effect(
  'correction and identifier/contact changes replace obsolete evidence instead of accumulating history',
  () =>
    Effect.gen(function* testScenario() {
      const [party] = snapshot.parties;
      expect(party).toBeTruthy();
      if (party === undefined) {
        throw new Error('Expected value to be present');
      }
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
      expect(yield* query('ACME')).toEqual([]);
      expect(yield* query('12345678')).toEqual([]);
      expect(yield* query('public@example.test')).toEqual([]);
      const corrected = yield* query('Corrected Company');
      expect(corrected.length).toBe(1);
    }),
);
it.effect(
  'a complete empty rebuild also rejects delayed evidence for a never-before-indexed Party',
  () =>
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
      expect(hits).toEqual([]);
    }),
);
