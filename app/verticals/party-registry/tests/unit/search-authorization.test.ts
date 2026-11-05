import { NodeCrypto } from '@effect/platform-node';
import {
  CoreSearchProjectionStore,
  TrustedPrincipalContextSchema,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchAuthorization, CoreSearchProjectionDocument, OperationalScope } from '@app/core-runtime';
import { ListAccessConditionSchema } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessCondition, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { TestAccessOutcome } from '@app/core-runtime/testing/access-gate';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { getReadHandler } from '../../../../packages/core-runtime/src/reads/definition.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';
import { DateTime, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import type {
  CounterpartySearchProjectionQuery,
  PartySearchProjectionGatewayService,
  PartySearchProjectionQuery,
} from '../../shared/domain/search-projection-gateway.ts';
import {
  COUNTERPARTY_SEARCH_NAME_PATH,
  PARTY_SEARCH_NAME_PATH,
  PARTY_SEARCH_NAME_TEXT_FIELDS,
  PartySearchProjectionGateway,
  partySearchAuthorization,
} from '../../shared/domain/search-projection-gateway.ts';
import { counterpartiesRead, loadCounterpartySearch } from '../../src/search/counterparties.provider.ts';
import { loadPartySearch, makePartySearchProjectionGateway, partiesRead } from '../../src/search/parties.provider.ts';
import { buildPartySearchDocuments } from '../../src/services/party-search-projection.service.ts';
import type {
  PartySearchSourceCounterparty,
  PartySearchSourceSnapshot,
} from '../../src/services/party-search-projection.service.ts';

/**
 * Both Party search reads must search with what their own gate already decided (O17, O25): the row
 * filter bounds the query before any candidate is selected, and a denied name takes every surface
 * that carries it out of matching, ordering and result metadata. These are the production channels:
 * the real read runtime hands the trusted answer to the owner, and the real Core Search runtime
 * answers the query it is given.
 */

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000009';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const otherLegalEntityId = '20000000-0000-4000-8000-000000000008';

const scopeOf = (input: { readonly legalEntityId?: string; readonly tenantId: string }) => {
  const scope = {
    ...Schema.decodeSync(TrustedPrincipalContextSchema)({
      authBindingId: '40000000-0000-4000-8000-000000000001',
      authContextRef: 'better-auth-session:party-search-authorization',
      authMethod: 'session',
      principalId: '30000000-0000-4000-8000-000000000003',
      tenantId: input.tenantId,
    }),
    correlationId: 'party-search-authorization',
  };
  return input.legalEntityId === undefined ? scope : { ...scope, legalEntityId: input.legalEntityId };
};
const tenantScope = scopeOf({ tenantId });
const counterpartyScope = scopeOf({ legalEntityId, tenantId });
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T09:00:00.000Z'));

const conditionOf = (encoded: (typeof ListAccessConditionSchema)['Encoded']): ListAccessCondition =>
  Schema.decodeUnknownSync(ListAccessConditionSchema)(encoded);
const filterOf = (...conditions: [ListAccessCondition, ...ListAccessCondition[]]): ListAccessPredicate => ({
  groups: [{ clauses: [{ conditions }] }],
});
const wholeScope = filterOf(conditionOf({ _tag: 'AllInScope' }));
const granted = (listAccess: ListAccessPredicate): CoreSearchAuthorization => ({ hiddenTextFields: [], listAccess });
const deniedNames = (listAccess: ListAccessPredicate): CoreSearchAuthorization => ({
  hiddenTextFields: PARTY_SEARCH_NAME_TEXT_FIELDS,
  listAccess,
});

/** What one owner query delivered, so a suite can read the answer the read handed its owner. */
type OwnerSearch =
  | {
      readonly authorization: CoreSearchAuthorization;
      readonly input: CounterpartySearchProjectionQuery;
      readonly kind: 'counterparties';
    }
  | {
      readonly authorization: CoreSearchAuthorization;
      readonly input: PartySearchProjectionQuery;
      readonly kind: 'parties';
    };

const recordingGateway = (searches: OwnerSearch[]): PartySearchProjectionGatewayService =>
  ({
    searchCounterparties: (input, _scope, authorization) =>
      Effect.sync(() => {
        searches.push({ authorization, input, kind: 'counterparties' });
        return [];
      }),
    searchParties: (input, _scope, authorization) =>
      Effect.sync(() => {
        searches.push({ authorization, input, kind: 'parties' });
        return [];
      }),
  }) satisfies PartySearchProjectionGatewayService;

it.layer(NodeCrypto.layer)('governed Party search authorization', (suite) => {
  suite.effect('carries the gate list filter and a denied name into the Party search query (O25, O17)', () =>
    Effect.gen(function* deniedPartyName() {
      const searches: OwnerSearch[] = [];
      const harness = yield* makeReadTestHarness({
        access: {
          'party.registry.party-search-identity.read': 'denied',
          'party.registry.party.search': 'allowed',
        },
        executeOwnerQuery: () => Effect.die('Party search reads through its Core projection gateway'),
        operationTime,
        ownerRegistration: partyRegistryBackendRegistration,
        ownerAuthorizationDecision: 'allowed',
        scope: tenantScope,
      });
      const result = yield* harness.runtime
        .runRead({
          input: { query: 'ACME' },
          principal: tenantScope,
          registration: partiesRead,
          transport: { correlationId: tenantScope.correlationId },
        })
        .pipe(Effect.provideService(PartySearchProjectionGateway, recordingGateway(searches)));

      expect(result).toEqual([]);
      expect(searches).toEqual([
        {
          // The trusted runtime channel, not a browser payload: the gate's predicate plus every
          // surface a Party's name travels on, so the name can neither match nor order a hit.
          authorization: { hiddenTextFields: PARTY_SEARCH_NAME_TEXT_FIELDS, listAccess: { groups: [] } },
          input: { includeArchived: false, query: 'ACME', tenantId },
          kind: 'parties',
        },
      ]);
    }),
  );

  suite.effect('carries the trusted company scope and the gate list filter into Counterparty search', () =>
    Effect.gen(function* grantedCounterpartyNames() {
      const searches: OwnerSearch[] = [];
      const harness = yield* makeReadTestHarness({
        access: {
          'party.registry.counterparty-search-identity.read': 'allowed',
          'party.registry.counterparty.search': 'allowed',
        },
        executeOwnerQuery: () => Effect.die('Counterparty search reads through its Core projection gateway'),
        operationTime,
        ownerRegistration: partyRegistryBackendRegistration,
        ownerAuthorizationDecision: 'allowed',
        scope: counterpartyScope,
      });
      yield* harness.runtime
        .runRead({
          input: { query: 'ACME', role: 'CUSTOMER' },
          principal: counterpartyScope,
          registration: counterpartiesRead,
          transport: { correlationId: counterpartyScope.correlationId },
        })
        .pipe(Effect.provideService(PartySearchProjectionGateway, recordingGateway(searches)));

      // A granted identity group hides nothing, and the search still carries the row filter: the
      // owner may not answer an authorization-free query just because every field is readable.
      expect(searches.map(({ authorization }) => authorization)).toEqual([
        { hiddenTextFields: [], listAccess: { groups: [] } },
      ]);
      const [search] = searches;
      if (search === undefined || search.kind !== 'counterparties') {
        return yield* Effect.die('Expected the recorded Counterparty query');
      }
      const { effectiveAt, ...ownerQuery } = search.input;
      // The effective time is the read's own clock, never a caller value.
      expect(effectiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      expect(ownerQuery).toEqual({
        includeArchived: false,
        legalEntityId,
        query: 'ACME',
        role: 'CUSTOMER',
        tenantId,
      });
    }),
  );

  suite.effect('refuses a search read the gate does not admit, before any owner query runs', () =>
    Effect.gen(function* deniedSearch() {
      const searches: OwnerSearch[] = [];
      const harness = yield* makeReadTestHarness({
        access: { 'party.registry.party.search': 'denied' },
        executeOwnerQuery: () => Effect.die('A denied search must not reach its owner query'),
        operationTime,
        ownerRegistration: partyRegistryBackendRegistration,
        ownerAuthorizationDecision: 'allowed',
        scope: tenantScope,
      });
      const failure = yield* harness.runtime
        .runRead({
          input: { query: 'ACME' },
          principal: tenantScope,
          registration: partiesRead,
          transport: { correlationId: tenantScope.correlationId },
        })
        .pipe(Effect.provideService(PartySearchProjectionGateway, recordingGateway(searches)), Effect.flip);

      expect(Predicate.isTagged(failure, 'ReadPermissionDenied')).toBe(true);
      expect(searches).toEqual([]);
    }),
  );
});

it('hides every name surface when the declared identity path is denied, and nothing else (O17)', () => {
  const authorizationOf = (deniedFieldPaths: readonly (readonly string[])[] | undefined) =>
    partySearchAuthorization({ deniedFieldPaths, listAccess: wholeScope, namePath: PARTY_SEARCH_NAME_PATH });

  // A denied Party name hides the title, the searchable text (which carries every alias's own text)
  // and the temporal text (which carries the name an ended alias or identifier leaves behind).
  expect(Option.getOrThrow(authorizationOf([['title']]))).toEqual({
    hiddenTextFields: ['searchableText', 'temporalSearchableText', 'title'],
    listAccess: wholeScope,
  });
  // A denied parent path denies its whole subtree, so `party` also hides `party.title`.
  expect(
    Option.getOrThrow(
      partySearchAuthorization({
        deniedFieldPaths: [['party']],
        listAccess: wholeScope,
        namePath: COUNTERPARTY_SEARCH_NAME_PATH,
      }),
    ).hiddenTextFields,
  ).toEqual(PARTY_SEARCH_NAME_TEXT_FIELDS);
  expect(
    Option.getOrThrow(
      partySearchAuthorization({
        deniedFieldPaths: [['party', 'title']],
        listAccess: wholeScope,
        namePath: COUNTERPARTY_SEARCH_NAME_PATH,
      }),
    ).hiddenTextFields,
  ).toEqual(PARTY_SEARCH_NAME_TEXT_FIELDS);
  // An unrelated denied field leaves the name matchable: hiding more than the gate answered would
  // silently narrow an authorized search.
  expect(Option.getOrThrow(authorizationOf([['officialIdentifiers', 'value']])).hiddenTextFields).toEqual([]);
  expect(Option.getOrThrow(authorizationOf([])).hiddenTextFields).toEqual([]);
});

it('answers no authorization when the read received no gate decision, so a caller fails closed', () => {
  // Both halves are the gate's answers. A read without them may not search at all: an absent filter
  // would scan the whole scope and an absent field answer would match every hidden name.
  expect(
    partySearchAuthorization({ deniedFieldPaths: undefined, listAccess: wholeScope, namePath: PARTY_SEARCH_NAME_PATH }),
  ).toEqual(Option.none());
  expect(
    partySearchAuthorization({
      deniedFieldPaths: [['title']],
      listAccess: undefined,
      namePath: PARTY_SEARCH_NAME_PATH,
    }),
  ).toEqual(Option.none());
  expect(
    partySearchAuthorization({ deniedFieldPaths: undefined, listAccess: undefined, namePath: PARTY_SEARCH_NAME_PATH }),
  ).toEqual(Option.none());
});

it('names the same result path in the read declaration and in the search authorization (O58)', () => {
  // A denied group is recognized by its declared result path, so the two must name the same path; a
  // renamed field group that still hides nothing would silently make a denied name matchable.
  expect((partiesRead.descriptor.accessFieldGroups ?? []).flatMap((group) => group.fields)).toEqual([
    PARTY_SEARCH_NAME_PATH.join('.'),
  ]);
  expect((counterpartiesRead.descriptor.accessFieldGroups ?? []).flatMap((group) => group.fields)).toEqual([
    COUNTERPARTY_SEARCH_NAME_PATH.join('.'),
  ]);
});

const partyRef = {
  moduleId: 'party.registry',
  resourceId: 'party-1',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const aliasRef = { ...partyRef, resourceId: 'party-absorbed' } as const;
const counterpartyRef = (resourceId: string): PartySearchSourceCounterparty['ref'] => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.counterparty',
  tenantId,
});
/** The identifier an absorbed identity leaves behind as the alias's own temporal text. */
const aliasIdentifier = { state: 'ACTIVE', validFrom: '2026-01-01T00:00:00.000Z', value: '87654321' };
const partyIdentity = {
  aliases: [],
  archived: false,
  contacts: [],
  displayName: 'ACME',
  identifiers: [{ state: 'ACTIVE', validFrom: '2026-01-01T00:00:00.000Z', value: '12345678' }],
  ref: partyRef,
};
const searchSnapshot: PartySearchSourceSnapshot = {
  counterparties: ['cp-1', 'cp-2'].map((resourceId): PartySearchSourceCounterparty => ({
    legalEntityId,
    partyRef,
    ref: counterpartyRef(resourceId),
    rolePeriods: [
      {
        role: 'CUSTOMER',
        state: 'ACTIVE',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2027-01-01T00:00:00.000Z',
      },
    ],
    storedPartyRef: aliasRef,
  })),
  parties: [
    {
      ...partyIdentity,
      aliases: [{ ...partyIdentity, displayName: 'Old Company', identifiers: [aliasIdentifier], ref: aliasRef }],
    },
  ],
  projectionVersion: '7',
  removedRefs: [],
  tenantId,
};
const projectionContext = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'party.registry',
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: 'party.registry',
  tenantSequenceNo: 1n,
  tenantId,
  topic: 'party.registry.party-updated.v1',
  workerKey: 'party.registry.project-party-updated-to-search',
});

/** The real ingestion documents, the real Core query runtime and the real Party adapter. */
const searchableParties = Effect.gen(function* searchablePartyProjection() {
  const documents = yield* buildPartySearchDocuments(searchSnapshot);
  const store = makeInMemoryCoreSearchProjectionStore();
  const search = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
  yield* Effect.forEach((document: CoreSearchProjectionDocument) =>
    store.apply({ document, kind: 'upsert' }, projectionContext),
  )(documents);
  return makePartySearchProjectionGateway(search);
});

it.effect('matches a Party name and its alias only while the name surfaces are granted (O17, O25)', () =>
  Effect.gen(function* hiddenPartyNames() {
    const gateway = yield* searchableParties;
    const query = { includeArchived: false, query: 'Old Company', tenantId };
    const counterpartyQuery = {
      effectiveAt: '2026-09-03T00:00:00.000Z',
      includeArchived: false,
      legalEntityId,
      tenantId,
    };

    // Positive control: with the identity group granted, the alias name matches both Counterparties.
    expect((yield* gateway.searchParties(query, tenantScope, granted(wholeScope))).length).toBe(1);
    const aliased = yield* gateway.searchCounterparties(
      { ...counterpartyQuery, query: 'Old Company' },
      counterpartyScope,
      granted(wholeScope),
    );
    expect(aliased.map(({ matchedPartyRef }) => matchedPartyRef?.resourceId)).toEqual([
      'party-absorbed',
      'party-absorbed',
    ]);

    // A denied name is not a surface: neither the Party title nor its alias text may confirm it.
    expect(yield* gateway.searchParties(query, tenantScope, deniedNames(wholeScope))).toEqual([]);
    expect(yield* gateway.searchParties({ ...query, query: 'ACME' }, tenantScope, deniedNames(wholeScope))).toEqual([]);
    expect(
      yield* gateway.searchCounterparties(
        { ...counterpartyQuery, query: 'Old Company' },
        counterpartyScope,
        deniedNames(wholeScope),
      ),
    ).toEqual([]);
  }),
);

it.effect('a denied title alone still matches the name through searchable text, so all surfaces are denied', () =>
  Effect.gen(function* titleOnlyDenial() {
    const gateway = yield* searchableParties;
    // Negative control for the mapping: the title is not the only name-bearing surface. A document
    // indexes its display name as searchable text too, and an alias keeps its own text there.
    const titleOnly = yield* gateway.searchParties({ includeArchived: false, query: 'ACME', tenantId }, tenantScope, {
      hiddenTextFields: ['title'],
      listAccess: wholeScope,
    });
    expect(titleOnly.length).toBe(1);
    // The hit reports no name, but its existence already confirms the hidden one (O25).
    expect(titleOnly.map(({ title }) => title)).toEqual(['[redacted]']);
  }),
);

it.effect('applies the gate row filter inside the query, before any hit is selected (O25)', () =>
  Effect.gen(function* narrowedRows() {
    const gateway = yield* searchableParties;
    const query = {
      effectiveAt: '2026-09-03T00:00:00.000Z',
      includeArchived: false,
      legalEntityId,
      query: 'ACME',
      tenantId,
    };
    expect(
      (yield* gateway.searchCounterparties(query, counterpartyScope, granted(wholeScope))).map(
        ({ counterpartyRef: ref }) => ref.resourceId,
      ),
    ).toEqual(['cp-1', 'cp-2']);
    // The owner answers exactly the rows the query returned: visibility is the predicate's, applied
    // by Core Search while it selects candidates, not a filter this provider runs afterwards.
    expect(
      (yield* gateway.searchCounterparties(
        query,
        counterpartyScope,
        granted(filterOf(conditionOf({ _tag: 'RecordKeyIn', recordKeys: ['cp-2'] }))),
      )).map(({ counterpartyRef: ref }) => ref.resourceId),
    ).toEqual(['cp-2']);
  }),
);

it.effect('refuses a query outside the trusted tenant or company, whatever the caller asked for', () =>
  Effect.gen(function* crossTenantQuery() {
    const gateway = yield* searchableParties;
    const query = {
      effectiveAt: '2026-09-03T00:00:00.000Z',
      includeArchived: false,
      legalEntityId,
      query: 'ACME',
      tenantId,
    };
    const failureOf = (input: typeof query, scope: typeof counterpartyScope) =>
      gateway.searchCounterparties(input, scope, granted(wholeScope)).pipe(Effect.flip);

    // Another tenant's rows are never reachable from this scope, and another company's rows are not
    // reachable from a company-scoped read: the trusted scope decides, not the query.
    expect(
      Predicate.isTagged(
        yield* failureOf({ ...query, tenantId: otherTenantId }, counterpartyScope),
        'PartySearchProjectionUnavailable',
      ),
    ).toBe(true);
    expect(
      Predicate.isTagged(
        yield* failureOf({ ...query, legalEntityId: otherLegalEntityId }, counterpartyScope),
        'PartySearchProjectionUnavailable',
      ),
    ).toBe(true);
  }),
);

/**
 * The two gate answers a search read needs before its owner may query (O25, O17): the capability for
 * the rows and the field group that carries the name. Everything else stays unauthorized on purpose.
 */
const grantedSearchAccess = {
  'party.registry.counterparty-search-identity.read': 'allowed',
  'party.registry.counterparty.search': 'allowed',
  'party.registry.party-search-identity.read': 'allowed',
  'party.registry.party.search': 'allowed',
} satisfies Readonly<Record<string, TestAccessOutcome>>;
const deniedNameSearchAccess = {
  ...grantedSearchAccess,
  'party.registry.counterparty-search-identity.read': 'denied',
  'party.registry.party-search-identity.read': 'denied',
} satisfies Readonly<Record<string, TestAccessOutcome>>;

/** Counts every owner query, so a refused or unanswered read can prove it never reached the index. */
const observedGateway = (gateway: PartySearchProjectionGatewayService, queries: string[]) =>
  ({
    searchCounterparties: (input, scope, authorization) =>
      Effect.sync(() => queries.push('counterparties')).pipe(
        Effect.andThen(() => gateway.searchCounterparties(input, scope, authorization)),
      ),
    searchParties: (input, scope, authorization) =>
      Effect.sync(() => queries.push('parties')).pipe(
        Effect.andThen(() => gateway.searchParties(input, scope, authorization)),
      ),
  }) satisfies PartySearchProjectionGatewayService;

/** The one hit fact a Party answer adds to the projection detail: whether the alias named it. */
const searchAnswerOf = ({
  matchedViaAlias,
  title,
}: {
  readonly matchedViaAlias: boolean;
  readonly title?: string;
}) => ({
  matchedViaAlias,
  title,
});

const harnessOf = (scope: OperationalScope, access: Readonly<Record<string, TestAccessOutcome>>) =>
  makeReadTestHarness({
    access,
    executeOwnerQuery: () => Effect.die('A Party search read queries only its Core projection'),
    operationTime,
    ownerRegistration: partyRegistryBackendRegistration,
    ownerAuthorizationDecision: 'allowed',
    scope,
  });

/**
 * One Party search exactly as a caller reaches it: the real read runtime asks the gate, hands the
 * owner the answer it decided, and the real Core Search runtime answers the query the owner builds.
 * The suites above prove the runtime channel and the query separately; this connects them.
 */
const searchPartiesThroughRuntime = (input: {
  readonly access: Readonly<Record<string, TestAccessOutcome>>;
  readonly gateway: PartySearchProjectionGatewayService;
  readonly query: string;
  readonly scope: OperationalScope;
}) =>
  Effect.gen(function* partiesSearchChain() {
    const harness = yield* harnessOf(input.scope, input.access);
    return yield* harness.runtime
      .runRead({
        input: { query: input.query },
        principal: input.scope,
        registration: partiesRead,
        transport: { correlationId: input.scope.correlationId },
      })
      .pipe(Effect.provideService(PartySearchProjectionGateway, input.gateway));
  });

const searchCounterpartiesThroughRuntime = (input: {
  readonly access: Readonly<Record<string, TestAccessOutcome>>;
  readonly gateway: PartySearchProjectionGatewayService;
  readonly query: string;
  readonly scope: OperationalScope;
}) =>
  Effect.gen(function* counterpartiesSearchChain() {
    const harness = yield* harnessOf(input.scope, input.access);
    return yield* harness.runtime
      .runRead({
        input: { query: input.query },
        principal: input.scope,
        registration: counterpartiesRead,
        transport: { correlationId: input.scope.correlationId },
      })
      .pipe(Effect.provideService(PartySearchProjectionGateway, input.gateway));
  });

// A Party search without an effective time uses the runtime clock (O25). Fix that clock inside
// the fixture's validity interval so temporal controls are independent of the machine's date.
it.layer(Layer.merge(NodeCrypto.layer, Layer.effectDiscard(TestClock.setTime(operationTime.getTime()))))(
  'governed Party search through the real read runtime',
  (suite) => {
    suite.effect(
      'answers a Party by its title, its alias and its temporal name text while they are granted (O17, O25)',
      () =>
        Effect.gen(function* visiblePartyNames() {
          const gateway = yield* searchableParties;
          const search = (query: string) =>
            searchPartiesThroughRuntime({ access: grantedSearchAccess, gateway, query, scope: tenantScope }).pipe(
              Effect.orDie,
            );
          // Legitimate visible control: every name-bearing surface of one granted Party reaches it.
          expect((yield* search('ACME')).map(searchAnswerOf)).toEqual([{ matchedViaAlias: false, title: 'ACME' }]);
          expect((yield* search('Old Company')).map(searchAnswerOf)).toEqual([
            { matchedViaAlias: true, title: 'ACME' },
          ]);
          // 12345678 is the Party's own identifier text, 87654321 the text its absorbed alias carries.
          expect((yield* search('12345678')).map(searchAnswerOf)).toEqual([{ matchedViaAlias: false, title: 'ACME' }]);
          expect((yield* search('87654321')).map(searchAnswerOf)).toEqual([{ matchedViaAlias: true, title: 'ACME' }]);
        }),
    );

    suite.effect(
      'hides the title, the alias and the temporal name text of the same Party when the field is denied (O25)',
      () =>
        Effect.gen(function* hiddenPartyNames() {
          const queries: string[] = [];
          const gateway = observedGateway(yield* searchableParties, queries);
          const search = (query: string) =>
            searchPartiesThroughRuntime({ access: deniedNameSearchAccess, gateway, query, scope: tenantScope }).pipe(
              Effect.orDie,
            );

          // Negative control: with the identity group denied, none of the four surfaces may confirm the
          // Party — not by matching, not by a count and not through the alias's own text.
          for (const query of ['ACME', 'Old Company', '12345678', '87654321']) {
            expect(yield* search(query)).toEqual([]);
          }
          // Every one of those reads still queried the index: the answer is empty because the surfaces
          // were not matchable, not because the search was skipped.
          expect(queries).toEqual(['parties', 'parties', 'parties', 'parties']);
        }),
    );

    suite.effect(
      'answers Counterparties of the trusted company only, and only with the Party name granted (O25, O28)',
      () =>
        Effect.gen(function* scopedCounterparties() {
          const gateway = yield* searchableParties;
          const search = (
            scope: OperationalScope,
            query: string,
            access: Readonly<Record<string, TestAccessOutcome>>,
          ) => searchCounterpartiesThroughRuntime({ access, gateway, query, scope }).pipe(Effect.orDie);

          const aliased = yield* search(counterpartyScope, 'Old Company', grantedSearchAccess);
          expect(
            aliased.map(({ party, ref }) => ({ matchedViaAlias: party.matchedViaAlias, resourceId: ref.resourceId })),
          ).toEqual([
            { matchedViaAlias: true, resourceId: 'cp-1' },
            { matchedViaAlias: true, resourceId: 'cp-2' },
          ]);
          // The company the trusted scope selected bounds the rows: the index holds none for the other
          // company, and the read answers none rather than widening to the tenant.
          expect(
            yield* search(
              { ...counterpartyScope, legalEntityId: otherLegalEntityId },
              'Old Company',
              grantedSearchAccess,
            ),
          ).toEqual([]);
          expect(yield* search(counterpartyScope, 'Old Company', deniedNameSearchAccess)).toEqual([]);
          expect(yield* search(counterpartyScope, 'ACME', deniedNameSearchAccess)).toEqual([]);
        }),
    );

    suite.effect('answers no search at all when the gate is unavailable or admits only an approval (O45, O62)', () =>
      Effect.gen(function* refusedSearch() {
        const queries: string[] = [];
        const gateway = observedGateway(yield* searchableParties, queries);
        const failureOf = (access: Readonly<Record<string, TestAccessOutcome>>) =>
          searchPartiesThroughRuntime({ access, gateway, query: 'ACME', scope: tenantScope }).pipe(Effect.flip);

        // A read is never proposable, so an approval-only answer is a refusal, and an unreadable
        // authority stays retryable. Neither may reach the index.
        expect(
          Predicate.isTagged(
            yield* failureOf({ 'party.registry.party.search': 'needs_approval' }),
            'ReadPermissionDenied',
          ),
        ).toBe(true);
        expect(
          Predicate.isTagged(
            yield* failureOf({ 'party.registry.party.search': 'unavailable' }),
            'ReadPermissionUnavailable',
          ),
        ).toBe(true);
        expect(queries).toEqual([]);
      }),
    );
  },
);

it.effect('answers only the rows its own gate predicate admits, inside the query (D16, O25)', () =>
  Effect.gen(function* admittedRows() {
    const gateway = yield* searchableParties;
    const search = (listAccess: ListAccessPredicate) =>
      getReadHandler(counterpartiesRead)(
        { includeArchived: false, query: 'ACME' },
        {
          deniedFieldPaths: [],
          listAccess,
          readKey: counterpartiesRead.descriptor.readKey,
          scope: counterpartyScope,
          services: {
            load: (ownerInput, authorization) =>
              loadCounterpartySearch(
                gateway,
                counterpartyScope,
                legalEntityId,
                ownerInput,
                '2026-09-03T00:00:00.000Z',
                authorization,
              ),
          },
        },
      ).pipe(Effect.provideService(PartySearchProjectionGateway, gateway), Effect.orDie);

    const whole = yield* search(wholeScope);
    expect(whole.result.map(({ ref }) => ref.resourceId)).toEqual(['cp-1', 'cp-2']);
    expect(whole.evidence.resultCount).toBe(2);

    // The predicate bounds candidates before matching, so the admitted row is the whole answer.
    const oneRow = yield* search(filterOf(conditionOf({ _tag: 'RecordKeyIn', recordKeys: ['cp-2'] })));
    expect(oneRow.result.map(({ ref }) => ref.resourceId)).toEqual(['cp-2']);
    // The count is the admitted answer too: an unadmitted row cannot inflate it.
    expect(oneRow.evidence.resultCount).toBe(1);

    const none = yield* search(filterOf(conditionOf({ _tag: 'RecordKeyIn', recordKeys: ['cp-absent'] })));
    expect(none).toEqual({ evidence: { resultCount: 0 }, result: [] });

    // This projection records no assignee, so an assigned-only grant admits no row at all: a row the
    // predicate cannot project is denied, never widened into an unfiltered match (D16, O25).
    const assignedOnly = yield* search(
      filterOf(
        conditionOf({
          _tag: 'AssignedTo',
          holder: { _tag: 'Principal', principalId: '30000000-0000-4000-8000-000000000003' },
        }),
      ),
    );
    expect(assignedOnly).toEqual({ evidence: { resultCount: 0 }, result: [] });
  }),
);

it.effect('bounds a Party search by the field answer the runtime handed it, and by nothing else (O17, O25)', () =>
  Effect.gen(function* trustedFieldAnswer() {
    const gateway = yield* searchableParties;
    const search = (deniedFieldPaths: readonly (readonly string[])[]) =>
      getReadHandler(partiesRead)(
        { query: 'ACME' },
        {
          deniedFieldPaths,
          listAccess: wholeScope,
          readKey: partiesRead.descriptor.readKey,
          scope: tenantScope,
          services: {
            load: (ownerInput, authorization) => loadPartySearch(gateway, tenantScope, ownerInput, authorization),
          },
        },
      ).pipe(Effect.provideService(PartySearchProjectionGateway, gateway), Effect.orDie);

    expect((yield* search([])).result.map(({ title }) => title)).toEqual(['ACME']);
    // The declared identity path hides the name; an unrelated denied path must not narrow the search.
    expect((yield* search([['title']])).result).toEqual([]);
    expect((yield* search([['officialIdentifiers', 'value']])).result.map(({ title }) => title)).toEqual(['ACME']);
    // A path below the name is not the name: only the declared group and the paths above it deny it.
    expect((yield* search([['title', 'value']])).result.map(({ title }) => title)).toEqual(['ACME']);
  }),
);

it.effect('fails closed when a search read carries no gate answer for its rows or its name field (O25)', () =>
  Effect.gen(function* missingGateAnswer() {
    const queries: string[] = [];
    const gateway = observedGateway(yield* searchableParties, queries);

    // The runtime supplies both halves for a protected read; a context missing either one is a
    // composition defect, and it must answer a retryable failure instead of an unrestricted search.
    const withoutRows = yield* getReadHandler(partiesRead)(
      { query: 'ACME' },
      {
        deniedFieldPaths: [],
        readKey: partiesRead.descriptor.readKey,
        scope: tenantScope,
        services: {
          load: (ownerInput, authorization) => loadPartySearch(gateway, tenantScope, ownerInput, authorization),
        },
      },
    ).pipe(Effect.provideService(PartySearchProjectionGateway, gateway), Effect.flip);
    const withoutFieldAnswer = yield* getReadHandler(partiesRead)(
      { query: 'ACME' },
      {
        listAccess: wholeScope,
        readKey: partiesRead.descriptor.readKey,
        scope: tenantScope,
        services: {
          load: (ownerInput, authorization) => loadPartySearch(gateway, tenantScope, ownerInput, authorization),
        },
      },
    ).pipe(Effect.provideService(PartySearchProjectionGateway, gateway), Effect.flip);
    const counterpartiesWithoutRows = yield* getReadHandler(counterpartiesRead)(
      { includeArchived: false, query: 'ACME' },
      {
        deniedFieldPaths: [],
        readKey: counterpartiesRead.descriptor.readKey,
        scope: counterpartyScope,
        services: {
          load: (ownerInput, authorization) =>
            loadCounterpartySearch(
              gateway,
              counterpartyScope,
              legalEntityId,
              ownerInput,
              '2026-09-03T00:00:00.000Z',
              authorization,
            ),
        },
      },
    ).pipe(Effect.provideService(PartySearchProjectionGateway, gateway), Effect.flip);

    const counterpartiesWithoutFieldAnswer = yield* getReadHandler(counterpartiesRead)(
      { includeArchived: false, query: 'ACME' },
      {
        listAccess: wholeScope,
        readKey: counterpartiesRead.descriptor.readKey,
        scope: counterpartyScope,
        services: {
          load: (ownerInput, authorization) =>
            loadCounterpartySearch(
              gateway,
              counterpartyScope,
              legalEntityId,
              ownerInput,
              '2026-09-03T00:00:00.000Z',
              authorization,
            ),
        },
      },
    ).pipe(Effect.provideService(PartySearchProjectionGateway, gateway), Effect.flip);

    for (const failure of [
      withoutRows,
      withoutFieldAnswer,
      counterpartiesWithoutRows,
      counterpartiesWithoutFieldAnswer,
    ]) {
      expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
    }
    expect(queries).toEqual([]);
  }),
);
