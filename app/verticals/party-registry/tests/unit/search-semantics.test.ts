import { Match, Predicate, Struct } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  CounterpartySearchProjectionHit,
  PartySearchProjectionHit,
} from '../../shared/domain/search-projection-gateway.ts';
import { normalizeCounterpartySearchHits, normalizePartySearchHits } from '../../shared/domain/search-semantics.ts';
import type { SearchNormalizationResult, SearchResults } from '../../shared/domain/search-semantics.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const partyRef = (resourceId: string) => ({
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.party' as const,
  tenantId,
});
const counterpartyRef = (resourceId: string) => ({
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
});

const expectSearchResults = <Result>(result: SearchNormalizationResult<Result>): SearchResults<Result> =>
  Match.value(result).pipe(
    Match.tag('SearchResults', (results) => results),
    Match.tag('SearchProjectionViolation', ({ reason }) => {
      throw new Error(`Expected normalized search results, but the projection was invalid: ${reason}`);
    }),
    Match.exhaustive,
  );

it('Party Search hides archived hits by default and explicitly labels included archived hits', () => {
  const hits: readonly PartySearchProjectionHit[] = [
    { archived: false, canonicalPartyRef: partyRef('active'), title: 'Active' },
    {
      archived: true,
      canonicalPartyRef: partyRef('archived'),
      title: 'Archived',
    },
  ];

  const activeResults = normalizePartySearchHits({ includeArchived: false, tenantId }, hits);
  expect(Predicate.isTagged(activeResults, 'SearchResults')).toBe(true);
  expect(Struct.omit(activeResults, ['_tag'])).toEqual({
    items: [
      {
        archived: false,
        matchedViaAlias: false,
        ref: partyRef('active'),
        title: 'Active',
      },
    ],
  });
  const included = normalizePartySearchHits({ includeArchived: true, tenantId }, hits);
  expect(Predicate.isTagged(included, 'SearchResults')).toBe(true);
  expect(expectSearchResults(included).items.map(({ archived }) => archived)).toEqual([false, true]);
});

it('Party aliases collapse to one survivor while shared contact queries may retain multiple Parties', () => {
  const survivor = partyRef('survivor');
  const result = normalizePartySearchHits({ includeArchived: false, tenantId }, [
    { archived: false, canonicalPartyRef: survivor, title: 'ACME' },
    {
      archived: false,
      canonicalPartyRef: survivor,
      matchedPartyRef: partyRef('absorbed'),
      title: 'ACME',
    },
    {
      archived: false,
      canonicalPartyRef: partyRef('shared-2'),
      title: 'Other person',
    },
  ]);

  expect(Predicate.isTagged(result, 'SearchResults')).toBe(true);
  const { items } = expectSearchResults(result);
  expect(items.map(({ ref }) => ref.resourceId)).toEqual(['survivor', 'shared-2']);
  expect(items[0]?.matchedViaAlias).toBe(true);
});

it('Party Search fails closed when Core returns a cross-tenant or inconsistent projection', () => {
  const wrongTenant = {
    ...partyRef('wrong'),
    tenantId: '90000000-0000-4000-8000-000000000009',
  };
  expect(
    Predicate.isTagged(
      normalizePartySearchHits({ includeArchived: true, tenantId }, [
        { archived: false, canonicalPartyRef: wrongTenant, title: 'Wrong' },
      ]),
      'SearchProjectionViolation',
    ),
  ).toBe(true);
  expect(
    Predicate.isTagged(
      normalizePartySearchHits({ includeArchived: true, tenantId }, [
        { archived: false, canonicalPartyRef: partyRef('same'), title: 'One' },
        { archived: true, canonicalPartyRef: partyRef('same'), title: 'Two' },
      ]),
      'SearchProjectionViolation',
    ),
  ).toBe(true);
});

const baseCounterpartyHit = (
  resourceId: string,
  partyId: string,
  rolePeriods: CounterpartySearchProjectionHit['rolePeriods'] = [],
): CounterpartySearchProjectionHit => ({
  canonicalPartyRef: partyRef(partyId),
  counterpartyRef: counterpartyRef(resourceId),
  legalEntity: { legalEntityId, tenantId },
  partyArchived: false,
  partyTitle: `Party ${partyId}`,
  rolePeriods,
});

it('Counterparty Search evaluates only current role periods at the exclusive time boundary', () => {
  const effectiveAt = '2026-09-03T12:00:00.000Z';
  const hits: readonly CounterpartySearchProjectionHit[] = [
    baseCounterpartyHit('ended', 'p1', [
      {
        role: 'CUSTOMER',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: effectiveAt,
      },
    ]),
    baseCounterpartyHit('future', 'p2', [{ role: 'CUSTOMER', validFrom: '2026-10-01T00:00:00.000Z' }]),
    baseCounterpartyHit('future-ended', 'p3', [
      {
        role: 'CUSTOMER',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2026-10-01T00:00:00.000Z',
      },
    ]),
    baseCounterpartyHit('dual', 'p4', [
      { role: 'CUSTOMER', validFrom: '2026-01-01T00:00:00.000Z' },
      { role: 'SUPPLIER', validFrom: '2026-02-01T00:00:00.000Z' },
    ]),
  ];
  const result = normalizeCounterpartySearchHits(
    {
      effectiveAt,
      includeArchived: false,
      legalEntityId,
      role: 'CUSTOMER',
      tenantId,
    },
    hits,
  );

  expect(Predicate.isTagged(result, 'SearchResults')).toBe(true);
  const { items } = expectSearchResults(result);
  expect(items.map(({ ref }) => ref.resourceId)).toEqual(['future-ended', 'dual']);
  expect(items[1]?.currentRoles).toEqual(['CUSTOMER', 'SUPPLIER']);
});

it('Counterparty Search without a role retains durable Counterparties with no current role', () => {
  const result = normalizeCounterpartySearchHits(
    {
      effectiveAt: '2026-09-03T12:00:00.000Z',
      includeArchived: false,
      legalEntityId,
      tenantId,
    },
    [baseCounterpartyHit('no-role', 'p1')],
  );

  expect(Predicate.isTagged(result, 'SearchResults')).toBe(true);
  expect(expectSearchResults(result).items[0]?.currentRoles).toEqual([]);
});

it('Counterparty identity dedupes independently and survivor collisions are surfaced', () => {
  const hits = [
    baseCounterpartyHit('cp-1', 'survivor'),
    baseCounterpartyHit('cp-1', 'survivor'),
    baseCounterpartyHit('cp-2', 'survivor'),
  ];
  const result = normalizeCounterpartySearchHits(
    {
      effectiveAt: '2026-09-03T12:00:00.000Z',
      includeArchived: false,
      legalEntityId,
      tenantId,
    },
    hits,
  );

  expect(Predicate.isTagged(result, 'SearchResults')).toBe(true);
  const { items } = expectSearchResults(result);
  expect(items.map(({ ref }) => ref.resourceId)).toEqual(['cp-1', 'cp-2']);
  expect(items.map(({ collision }) => collision?.counterpartyRefs.map(({ resourceId }) => resourceId))).toEqual([
    ['cp-1', 'cp-2'],
    ['cp-1', 'cp-2'],
  ]);
});

it('Counterparty Search fails closed on the wrong Legal Entity instead of broadening scope', () => {
  const result = normalizeCounterpartySearchHits(
    {
      effectiveAt: '2026-09-03T12:00:00.000Z',
      includeArchived: true,
      legalEntityId,
      tenantId,
    },
    [
      {
        ...baseCounterpartyHit('wrong-le', 'p1'),
        legalEntity: {
          legalEntityId: '80000000-0000-4000-8000-000000000008',
          tenantId,
        },
      },
    ],
  );

  expect(Predicate.isTagged(result, 'SearchProjectionViolation')).toBe(true);
});
