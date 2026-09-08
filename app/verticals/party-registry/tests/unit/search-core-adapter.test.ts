import { CoreSearchProjectionHitSchema } from '@app/core-runtime';
import type { CoreSearchQueryRuntimeService } from '@app/core-runtime';
import { Effect, Schema, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { makePartySearchProjectionGateway } from '../../src/search/parties.provider.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const partyRef = (resourceId: string) => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});
const counterpartyRef = (resourceId: string) => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.counterparty',
  tenantId,
});
const partyAliasHit = Schema.decodeSync(CoreSearchProjectionHitSchema)({
  archived: false,
  facets: [],
  matchedRef: partyRef('absorbed'),
  metadata: [],
  ref: partyRef('survivor'),
  title: 'ACME',
});
const counterpartyHit = Schema.decodeSync(CoreSearchProjectionHitSchema)({
  archived: false,
  facets: [],
  matchedSubjectRef: partyRef('absorbed'),
  metadata: [],
  ref: counterpartyRef('cp-1'),
  selectedLegalEntityId: legalEntityId,
  subjectRef: partyRef('survivor'),
  temporalFacets: [
    {
      key: 'current-role',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2027-01-01T00:00:00.000Z',
      value: 'CUSTOMER',
    },
    {
      key: 'ignored-business-facet',
      validFrom: '2026-01-01T00:00:00.000Z',
      value: 'IGNORED',
    },
  ],
  title: 'ACME',
});
const wrongResourceHit = Schema.decodeSync(CoreSearchProjectionHitSchema)({
  archived: false,
  facets: [],
  metadata: [],
  ref: counterpartyRef('wrong-kind'),
  title: 'Wrong',
});

it.effect(
  'Party adapter queries only the Core-owned Party projection and maps alias context',
  () =>
    Effect.gen(function* partyAdapterQuery() {
      const calls: unknown[] = [];
      const core: CoreSearchQueryRuntimeService = {
        search: (input) => {
          calls.push(input);
          return Effect.succeed([partyAliasHit]);
        },
      };

      const gateway = makePartySearchProjectionGateway(core);
      const hits = yield* gateway.searchParties({
        includeArchived: true,
        query: 'ACME',
        tenantId,
      });

      expect(calls).toEqual([
        {
          includeArchived: true,
          moduleId: 'party.registry',
          query: 'ACME',
          resourceType: 'party.registry.party',
          tenantId,
        },
      ]);
      expect(hits).toEqual([
        {
          archived: false,
          canonicalPartyRef: partyRef('survivor'),
          matchedPartyRef: partyRef('absorbed'),
          title: 'ACME',
        },
      ]);
    })
);

it.effect(
  'Counterparty adapter uses trusted Legal Entity, effective time, role facet and safe periods',
  () =>
    Effect.gen(function* counterpartyAdapterQuery() {
      const calls: unknown[] = [];
      const core: CoreSearchQueryRuntimeService = {
        search: (input) => {
          calls.push(input);
          return Effect.succeed([counterpartyHit]);
        },
      };
      const effectiveAt = '2026-09-03T12:00:00.000Z';

      const hits = yield* makePartySearchProjectionGateway(
        core
      ).searchCounterparties({
        effectiveAt,
        includeArchived: false,
        legalEntityId,
        query: 'ACME',
        role: 'CUSTOMER',
        tenantId,
      });

      expect(calls).toEqual([
        {
          effectiveAt,
          facets: [{ key: 'current-role', values: ['CUSTOMER'] }],
          includeArchived: false,
          moduleId: 'party.registry',
          query: 'ACME',
          resourceType: 'party.registry.counterparty',
          selectedLegalEntityId: legalEntityId,
          tenantId,
        },
      ]);
      expect(hits).toEqual([
        {
          canonicalPartyRef: partyRef('survivor'),
          counterpartyRef: counterpartyRef('cp-1'),
          legalEntity: { legalEntityId, tenantId },
          matchedPartyRef: partyRef('absorbed'),
          partyArchived: false,
          partyTitle: 'ACME',
          rolePeriods: [
            {
              role: 'CUSTOMER',
              validFrom: '2026-01-01T00:00:00.000Z',
              validTo: '2027-01-01T00:00:00.000Z',
            },
          ],
        },
      ]);
    })
);

it.effect(
  'Party adapter fails closed when a generic projection returns the wrong resource contract',
  () =>
    Effect.gen(function* invalidProjectionContract() {
      const core: CoreSearchQueryRuntimeService = {
        search: () => Effect.succeed([wrongResourceHit]),
      };

      const failure = yield* Effect.exit(
        makePartySearchProjectionGateway(core).searchParties({
          includeArchived: false,
          query: 'Wrong',
          tenantId,
        })
      );
      expect(Predicate.isTagged(failure, 'Failure')).toBeTruthy();
    })
);
