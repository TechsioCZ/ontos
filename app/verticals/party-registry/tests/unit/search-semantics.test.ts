import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeCounterpartySearchHits,
  normalizePartySearchHits,
} from '../../shared/domain/search-semantics.ts';
import type {
  CounterpartySearchProjectionHit,
  PartySearchProjectionHit,
} from '../../shared/domain/search-projection-gateway.ts';

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

test('Party Search hides archived hits by default and explicitly labels included archived hits', () => {
  const hits: readonly PartySearchProjectionHit[] = [
    { archived: false, canonicalPartyRef: partyRef('active'), title: 'Active' },
    { archived: true, canonicalPartyRef: partyRef('archived'), title: 'Archived' },
  ];

  assert.deepEqual(normalizePartySearchHits({ includeArchived: false, tenantId }, hits), {
    _tag: 'SearchResults',
    items: [{ archived: false, matchedViaAlias: false, ref: partyRef('active'), title: 'Active' }],
  });
  const included = normalizePartySearchHits({ includeArchived: true, tenantId }, hits);
  assert.equal(included._tag, 'SearchResults');
  assert.deepEqual(
    included._tag === 'SearchResults' ? included.items.map(({ archived }) => archived) : [],
    [false, true],
  );
});

test('Party aliases collapse to one survivor while shared contact queries may retain multiple Parties', () => {
  const survivor = partyRef('survivor');
  const result = normalizePartySearchHits({ includeArchived: false, tenantId }, [
    { archived: false, canonicalPartyRef: survivor, title: 'ACME' },
    {
      archived: false,
      canonicalPartyRef: survivor,
      matchedPartyRef: partyRef('absorbed'),
      title: 'ACME',
    },
    { archived: false, canonicalPartyRef: partyRef('shared-2'), title: 'Other person' },
  ]);

  assert.equal(result._tag, 'SearchResults');
  if (result._tag === 'SearchResults') {
    assert.deepEqual(
      result.items.map(({ ref }) => ref.resourceId),
      ['survivor', 'shared-2'],
    );
    assert.equal(result.items[0]?.matchedViaAlias, true);
  }
});

test('Party Search fails closed when Core returns a cross-tenant or inconsistent projection', () => {
  const wrongTenant = {
    ...partyRef('wrong'),
    tenantId: '90000000-0000-4000-8000-000000000009',
  };
  assert.equal(
    normalizePartySearchHits({ includeArchived: true, tenantId }, [
      { archived: false, canonicalPartyRef: wrongTenant, title: 'Wrong' },
    ])._tag,
    'SearchProjectionViolation',
  );
  assert.equal(
    normalizePartySearchHits({ includeArchived: true, tenantId }, [
      { archived: false, canonicalPartyRef: partyRef('same'), title: 'One' },
      { archived: true, canonicalPartyRef: partyRef('same'), title: 'Two' },
    ])._tag,
    'SearchProjectionViolation',
  );
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

test('Counterparty Search evaluates only current role periods at the exclusive time boundary', () => {
  const effectiveAt = '2026-09-03T12:00:00.000Z';
  const hits: readonly CounterpartySearchProjectionHit[] = [
    baseCounterpartyHit('ended', 'p1', [
      { role: 'CUSTOMER', validFrom: '2026-01-01T00:00:00.000Z', validTo: effectiveAt },
    ]),
    baseCounterpartyHit('future', 'p2', [
      { role: 'CUSTOMER', validFrom: '2026-10-01T00:00:00.000Z' },
    ]),
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
    { effectiveAt, includeArchived: false, legalEntityId, role: 'CUSTOMER', tenantId },
    hits,
  );

  assert.equal(result._tag, 'SearchResults');
  if (result._tag === 'SearchResults') {
    assert.deepEqual(
      result.items.map(({ ref }) => ref.resourceId),
      ['future-ended', 'dual'],
    );
    assert.deepEqual(result.items[1]?.currentRoles, ['CUSTOMER', 'SUPPLIER']);
  }
});

test('Counterparty Search without a role retains durable Counterparties with no current role', () => {
  const result = normalizeCounterpartySearchHits(
    {
      effectiveAt: '2026-09-03T12:00:00.000Z',
      includeArchived: false,
      legalEntityId,
      tenantId,
    },
    [baseCounterpartyHit('no-role', 'p1')],
  );

  assert.equal(result._tag, 'SearchResults');
  if (result._tag === 'SearchResults') {
    assert.deepEqual(result.items[0]?.currentRoles, []);
  }
});

test('Counterparty identity dedupes independently and survivor collisions are surfaced', () => {
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

  assert.equal(result._tag, 'SearchResults');
  if (result._tag === 'SearchResults') {
    assert.deepEqual(
      result.items.map(({ ref }) => ref.resourceId),
      ['cp-1', 'cp-2'],
    );
    assert.deepEqual(
      result.items.map(({ collision }) =>
        collision?.counterpartyRefs.map(({ resourceId }) => resourceId),
      ),
      [
        ['cp-1', 'cp-2'],
        ['cp-1', 'cp-2'],
      ],
    );
  }
});

test('Counterparty Search fails closed on the wrong Legal Entity instead of broadening scope', () => {
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

  assert.equal(result._tag, 'SearchProjectionViolation');
});
