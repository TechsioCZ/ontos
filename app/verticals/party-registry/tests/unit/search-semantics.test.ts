import { Match, Predicate, Schema, Struct } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  CounterpartySearchProjectionHit,
  PartySearchProjectionHit,
} from '../../shared/domain/search-projection-gateway.ts';
import {
  CurrentPartySearchTimeSchema,
  normalizeCounterpartySearchHits,
  normalizePartySearchHits,
  rematchCurrentPartySearchHits,
} from '../../shared/domain/search-semantics.ts';
import type {
  CurrentPartySearchEvidence,
  CurrentPartySearchIdentity,
  SearchNormalizationResult,
  SearchResults,
} from '../../shared/domain/search-semantics.ts';

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
  expect(items[0]?.matchedViaAlias).toBe(false);
});

const effectiveAt = '2026-11-04T12:00:00.000Z';
const currentTime = Schema.decodeSync(CurrentPartySearchTimeSchema)(effectiveAt);
const currentIdentity = (id: string, displayName = 'Jana Nováková'): CurrentPartySearchIdentity => ({
  archived: false,
  contacts: [],
  displayName,
  identifiers: [],
  ref: partyRef(id),
});
const publicEmail = {
  isCurrent: true,
  privacy: 'PUBLIC',
  state: 'ACTIVE',
  type: 'EMAIL',
  validFrom: '2026-01-01T00:00:00.000Z',
  value: 'withdrawn@example.test',
};
const rematch = (
  query: string,
  identities: readonly CurrentPartySearchIdentity[],
  hits: readonly PartySearchProjectionHit[] = [
    { archived: false, canonicalPartyRef: partyRef('person'), title: 'Stale projected title' },
  ],
  aliases: CurrentPartySearchEvidence['aliases'] = [],
  authorized = new Set(identities.map(({ ref }) => ref.resourceId)),
) =>
  rematchCurrentPartySearchHits(
    { effectiveAt: currentTime, includeArchived: false, query, tenantId },
    hits,
    { aliases, identities },
    authorized,
  );

it('withdrawn/corrected or non-public contacts cannot supply any query token during delivery lag', () => {
  for (const contact of [
    { ...publicEmail, state: 'RETRACTED', isCurrent: false },
    { ...publicEmail, state: 'SUPERSEDED', isCurrent: false },
    { ...publicEmail, state: 'DISPUTED' },
    { ...publicEmail, state: 'ENDED' },
    { ...publicEmail, isCurrent: false },
    { ...publicEmail, privacy: 'PERSONAL' },
    { ...publicEmail, privacy: 'BUSINESS_SENSITIVE' },
    { ...publicEmail, type: 'ADDRESS' },
    { ...publicEmail, validFrom: '2026-12-01T00:00:00.000Z' },
    { ...publicEmail, validTo: effectiveAt },
    { ...publicEmail, validTo: 'invalid' },
  ]) {
    const identity = { ...currentIdentity('person'), contacts: [contact] };
    expect(expectSearchResults(rematch('withdrawn@example.test', [identity])).items).toEqual([]);
    expect(expectSearchResults(rematch('Jana withdrawn@example.test', [identity])).items).toEqual([]);
    expect(expectSearchResults(rematch('Novakova Jana', [identity])).items).toEqual([
      { archived: false, canonicalPartyRef: partyRef('person'), title: 'Jana Nováková' },
    ]);
  }
});

it('a correction replacement cannot keep its superseded contact searchable', () => {
  const corrected = {
    ...currentIdentity('person'),
    contacts: [
      { ...publicEmail, state: 'SUPERSEDED', isCurrent: false },
      { ...publicEmail, value: 'replacement@example.test' },
    ],
  };
  expect(expectSearchResults(rematch(publicEmail.value, [corrected])).items).toEqual([]);
  expect(expectSearchResults(rematch('replacement@example.test', [corrected])).items).toEqual([
    { archived: false, canonicalPartyRef: partyRef('person'), title: 'Jana Nováková' },
  ]);
});

it('current public email/phone and identifier periods still select without exposing their values', () => {
  const identity = {
    ...currentIdentity('person'),
    contacts: [publicEmail, { ...publicEmail, type: 'PHONE', value: '+420777888999' }],
  };
  for (const query of [publicEmail.value, '+420777888999', 'Jana withdrawn@example.test']) {
    const results = expectSearchResults(rematch(query, [identity])).items;
    expect(results).toEqual([{ archived: false, canonicalPartyRef: partyRef('person'), title: 'Jana Nováková' }]);
    expect(JSON.stringify(results)).not.toContain(publicEmail.value);
  }
  const identified = { ...currentIdentity('person'), identifiers: [{ ...publicEmail, value: '12345678' }] };
  expect(expectSearchResults(rematch('12345678', [identified])).items).toHaveLength(1);
  expect(
    expectSearchResults(
      rematch('12345678', [
        { ...identified, identifiers: [{ ...publicEmail, value: '12345678', validTo: effectiveAt }] },
      ]),
    ).items,
  ).toEqual([]);
});

it('a stale alias match is re-attributed only through a current authorized alias, canonical first', () => {
  const canonical = currentIdentity('person');
  const alias = { ...currentIdentity('alias', 'Older name'), contacts: [publicEmail] };
  const hit = { archived: false, canonicalPartyRef: canonical.ref, matchedPartyRef: alias.ref, title: 'Old name' };
  const aliases = [{ aliasPartyRef: alias.ref, canonicalPartyRef: canonical.ref }];
  expect(
    expectSearchResults(rematch(publicEmail.value, [canonical, alias], [hit], aliases)).items[0]?.matchedPartyRef,
  ).toEqual(alias.ref);
  expect(
    expectSearchResults(rematch(publicEmail.value, [canonical, { ...alias, contacts: [] }], [hit], aliases)).items,
  ).toEqual([]);
  expect(expectSearchResults(rematch(publicEmail.value, [canonical, alias], [hit], [])).items).toEqual([]);
  expect(
    expectSearchResults(rematch(publicEmail.value, [canonical, alias], [hit], aliases, new Set(['person']))).items,
  ).toEqual([]);
  expect(
    expectSearchResults(rematch(publicEmail.value, [canonical, alias], [hit], aliases, new Set(['alias']))).items,
  ).toEqual([]);
  const canonicalMatch = { ...canonical, contacts: [publicEmail] };
  expect(
    expectSearchResults(rematch(publicEmail.value, [canonicalMatch, alias], [hit], aliases)).items[0],
  ).not.toHaveProperty('matchedPartyRef');
  const otherAlias = { ...alias, ref: partyRef('authorized-alias') };
  expect(
    expectSearchResults(
      rematch(
        publicEmail.value,
        [canonical, alias, otherAlias],
        [hit],
        [...aliases, { aliasPartyRef: otherAlias.ref, canonicalPartyRef: canonical.ref }],
        new Set(['person', 'authorized-alias']),
      ),
    ).items[0]?.matchedPartyRef,
  ).toEqual(otherAlias.ref);
});

it('current alias chains reject cycles, broken targets and tenant crossing before selection', () => {
  const canonical = currentIdentity('person');
  const alias = { ...currentIdentity('alias'), contacts: [publicEmail] };
  for (const aliases of [
    [{ aliasPartyRef: alias.ref, canonicalPartyRef: partyRef('missing') }],
    [{ aliasPartyRef: alias.ref, canonicalPartyRef: alias.ref }],
    [
      { aliasPartyRef: alias.ref, canonicalPartyRef: canonical.ref },
      { aliasPartyRef: canonical.ref, canonicalPartyRef: alias.ref },
    ],
    [{ aliasPartyRef: alias.ref, canonicalPartyRef: { ...canonical.ref, tenantId: 'foreign' } }],
  ]) {
    expect(
      Predicate.isTagged(
        rematch(publicEmail.value, [canonical, alias], undefined, aliases),
        'SearchProjectionViolation',
      ),
    ).toBe(true);
  }
  const middle = currentIdentity('middle');
  expect(
    expectSearchResults(
      rematch(publicEmail.value, [canonical, middle, alias], undefined, [
        { aliasPartyRef: alias.ref, canonicalPartyRef: middle.ref },
        { aliasPartyRef: middle.ref, canonicalPartyRef: canonical.ref },
      ]),
    ).items[0]?.matchedPartyRef,
  ).toEqual(alias.ref);
});

it('hidden/stale contact values cannot change surviving hit order, title or alias explanation', () => {
  const first = currentIdentity('first', 'Jana');
  const second = currentIdentity('second', 'Jana Nováková');
  const hits = [second, first].map((identity) => ({
    archived: false,
    canonicalPartyRef: identity.ref,
    title: 'Projected contact-biased order',
  }));
  const baseline = expectSearchResults(rematch('Jana', [first, second], hits)).items;
  const hidden = expectSearchResults(
    rematch(
      'Jana',
      [
        { ...first, contacts: [{ ...publicEmail, privacy: 'PERSONAL', value: 'Jana' }] },
        { ...second, contacts: [{ ...publicEmail, state: 'SUPERSEDED', value: 'Jana' }] },
      ],
      hits.toReversed(),
    ),
  ).items;
  expect(hidden).toEqual(baseline);
  expect(hidden.map(({ canonicalPartyRef }) => canonicalPartyRef.resourceId)).toEqual(['first', 'second']);
});

it('current canonical archive state, not projected state, decides inclusion', () => {
  expect(expectSearchResults(rematch('Jana', [{ ...currentIdentity('person'), archived: true }])).items).toEqual([]);
  expect(
    expectSearchResults(
      rematch(
        'Jana',
        [currentIdentity('person')],
        [{ archived: true, canonicalPartyRef: partyRef('person'), title: 'Stale archive' }],
      ),
    ).items,
  ).toHaveLength(1);
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
  const roleBoundary = '2026-09-03T12:00:00.000Z';
  const hits: readonly CounterpartySearchProjectionHit[] = [
    baseCounterpartyHit('ended', 'p1', [
      {
        role: 'CUSTOMER',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: roleBoundary,
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
      effectiveAt: roleBoundary,
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

it('canonical evidence wins over alias explanations regardless of duplicate hit ordering', () => {
  const canonical = baseCounterpartyHit('cp-1', 'survivor');
  const alias = { ...canonical, matchedPartyRef: partyRef('absorbed') };
  for (const hits of [
    [canonical, alias],
    [alias, canonical],
  ]) {
    const parties = normalizePartySearchHits(
      { includeArchived: false, tenantId },
      hits.map((hit) => {
        const base = { archived: hit.partyArchived, canonicalPartyRef: hit.canonicalPartyRef, title: hit.partyTitle };
        return hit.matchedPartyRef === undefined ? base : { ...base, matchedPartyRef: hit.matchedPartyRef };
      }),
    );
    expect(expectSearchResults(parties).items[0]?.matchedViaAlias).toBe(false);
    const counterparties = normalizeCounterpartySearchHits(
      { effectiveAt, includeArchived: false, legalEntityId, tenantId },
      hits,
    );
    expect(expectSearchResults(counterparties).items[0]?.party.matchedViaAlias).toBe(false);
  }
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
