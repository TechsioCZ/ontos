import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { parseCrmSearchPredicate } from '../../src/search/record-access.ts';
import { crmRegistration } from '../../vertical.registration.ts';
import {
  ContextAccess,
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
} from '@app/core-runtime';
import { CoreSearchRelevanceSchema } from '@app/core-runtime/search-contract';
import type { CoreSearchRelevance } from '@app/core-runtime/search-contract';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import {
  PrincipalIdSchema as AccessPrincipalIdSchema,
  RecordKeySchema,
  CurrencyCodeSchema,
} from '@app/core-runtime/access/ids';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { CrmStateSchema } from '../../shared/domain/state.ts';
import { crmSearchQuery } from '../../shared/domain/search-contact-classification.ts';
import { clientsRead, loadCrmSearch } from '../../src/search/clients.provider.ts';
import { contactsRead } from '../../src/search/contacts.provider.ts';
import { recordsRead } from '../../src/api/records.read.ts';
import { expect, it } from 'effect-rstest';
import { ClientsProviderRequestSchema, ClientsProviderResponseSchema } from '../../shared/apis/clients-search.ts';
import type { ClientsProviderResponse } from '../../shared/apis/clients-search.ts';
import { ContactsProviderRequestSchema, ContactsProviderResponseSchema } from '../../shared/apis/contacts-search.ts';
import type { ContactsProviderResponse } from '../../shared/apis/contacts-search.ts';
import { buildSearchDocuments } from '../../src/services/search-projection.service.ts';
import { companyId, context, otherCompanyId, scope, snapshot, state } from './search-fixtures.ts';

it.effect('requires tenant/company on raw hits and drops forged, archived, wrong-type and unassigned rows', () =>
  Effect.gen(function* checkSearchScope() {
    const docs = yield* buildSearchDocuments(snapshot);
    const hits = docs;
    let calls = 0;
    const gateway: CoreSearchQueryRuntime['Service'] = {
      search: (input, trustedScope) =>
        Effect.sync(() => {
          calls += 1;
          expect(trustedScope).toEqual(scope);
          expect(input).toMatchObject({
            includeArchived: false,
            selectedLegalEntityId: companyId,
            tenantId: scope.tenantId,
          });
          const client = hits.find((hit) => hit.ref.resourceType === 'demo.crm.client');
          if (client === undefined) {
            return [];
          }
          return [
            client,
            Schema.decodeUnknownSync(CoreSearchProjectionHitSchema)({
              ...client,
              selectedLegalEntityId: otherCompanyId,
            }),
            Schema.decodeUnknownSync(CoreSearchProjectionHitSchema)({
              ...client,
              ref: { ...client.ref, tenantId: otherCompanyId },
            }),
            { ...client, archived: true },
            ...hits.filter((hit) => hit.ref.resourceType === 'demo.crm.contact'),
          ];
        }),
    };
    const clients = yield* loadCrmSearch(scope, {
      query: 'hanak',
      resourceType: 'demo.crm.client',
      visible: state,
    }).pipe(Effect.provideService(CoreSearchQueryRuntime, gateway));
    expect(clients.length).toBe(1);
    expect(Schema.is(ClientsProviderResponseSchema)(clients)).toBe(true);
    expect(
      yield* loadCrmSearch(scope, {
        query: 'hanak',
        resourceType: 'demo.crm.client',
        visible: { ...state, clients: { ...state.clients, items: [] } },
      }).pipe(Effect.provideService(CoreSearchQueryRuntime, gateway)),
    ).toEqual([]);
    const contacts = yield* loadCrmSearch(scope, {
      query: 'jiri',
      resourceType: 'demo.crm.contact',
      visible: state,
    }).pipe(Effect.provideService(CoreSearchQueryRuntime, gateway));
    expect(contacts.length).toBe(1);
    expect(Schema.is(ContactsProviderResponseSchema)(contacts)).toBe(true);
    expect(Schema.is(ClientsProviderResponseSchema)([{ ref: clients[0]?.ref, title: 'name' }])).toBe(false);
    expect(
      Schema.is(ClientsProviderResponseSchema)([
        { ...clients[0], ref: { moduleId: 'demo.crm', resourceId: 'client-1', resourceType: 'demo.crm.client' } },
      ]),
    ).toBe(false);
    expect(calls).toBe(3);
  }),
);

interface ReaderScenario {
  readonly assigned: boolean;
  readonly broad: boolean;
  readonly currentState?: typeof state;
  readonly entrypointAllowed?: boolean;
  readonly expectedCount: number | null;
  readonly expectedIndexScore?: number;
  readonly expectedScore?: number;
  readonly expectedTitle?: string;
  readonly indexCount?: number;
  readonly indexState?: typeof state;
  readonly missingPredicate?: boolean;
  readonly ownerSnapshot?:
    | 'missing'
    | 'deleted'
    | 'archived-client'
    | 'client-archived-at'
    | 'archived-contact'
    | 'contact-archived-at'
    | 'contact-withdrawn'
    | 'orphan-contact'
    | 'assignment-removed'
    | 'missing-salesperson'
    | 'inactive-salesperson'
    | 'different-principal';
  readonly predicate?: ListAccessPredicate;
  readonly query?: string;
  readonly readable?: boolean;
  readonly readOutcome?: 'DENIED' | 'UNAVAILABLE';
  readonly refreshBroadGrant?: boolean;
  readonly resourceType: 'demo.crm.client' | 'demo.crm.contact';
  readonly selectedCompanyId?: string;
}
interface SearchResultEvidence {
  readonly ref: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  };
  readonly relevance?: CoreSearchRelevance;
  readonly selectedLegalEntityId: string;
  readonly title: string;
}
const checkResult = (result: readonly SearchResultEvidence[], withRelevance = false) => {
  for (const hit of result) {
    expect(new Set(Object.keys(hit))).toEqual(
      new Set(['ref', ...(withRelevance ? ['relevance'] : []), 'selectedLegalEntityId', 'title']),
    );
    if (withRelevance) {
      expect(Schema.is(CoreSearchRelevanceSchema)(hit.relevance)).toBe(true);
    }
  }
  expect(JSON.stringify(result)).not.toMatch(/@|777111|606333|private/u);
  return result.length;
};

const ownerStateFor = (encoded: typeof CrmStateSchema.Encoded, scenario: ReaderScenario, actorPrincipalId: string) => {
  const stored = {
    ...encoded,
    clients: {
      ...encoded.clients,
      items: encoded.clients.items.map((client) => ({
        ...client,
        ownerSalespersonId: scenario.assigned ? 'rep-1' : 'another-rep',
      })),
    },
    salespeople: [{ active: true, id: 'rep-1', name: 'Assigned salesperson', principalId: actorPrincipalId }],
  };
  if (scenario.ownerSnapshot === 'deleted') {
    stored.clients.items = [];
  } else if (scenario.ownerSnapshot === 'assignment-removed') {
    for (const client of stored.clients.items) {
      Reflect.deleteProperty(client, 'ownerSalespersonId');
    }
  } else if (scenario.ownerSnapshot === 'archived-client') {
    stored.clients.items = stored.clients.items.map((client) => ({ ...client, status: 'archived' }));
  } else if (scenario.ownerSnapshot === 'client-archived-at') {
    stored.clients.items = stored.clients.items.map((client) => ({
      ...client,
      archivedAt: '2026-01-02T00:00:00.000Z',
    }));
  } else if (scenario.ownerSnapshot === 'archived-contact') {
    stored.clients.contacts = stored.clients.contacts.map((contact) => ({ ...contact, status: 'archived' }));
  } else if (scenario.ownerSnapshot === 'contact-archived-at') {
    stored.clients.contacts = stored.clients.contacts.map((contact) => ({
      ...contact,
      archivedAt: '2026-01-02T00:00:00.000Z',
    }));
  } else if (scenario.ownerSnapshot === 'contact-withdrawn') {
    stored.clients.contacts = [];
  } else if (scenario.ownerSnapshot === 'orphan-contact') {
    stored.clients.contacts = stored.clients.contacts.map((contact) => ({ ...contact, clientId: 'missing-parent' }));
  } else if (scenario.ownerSnapshot === 'missing-salesperson') {
    stored.salespeople = [];
  } else if (scenario.ownerSnapshot === 'inactive-salesperson') {
    stored.salespeople = stored.salespeople.map((person) => ({ ...person, active: false }));
  } else if (scenario.ownerSnapshot === 'different-principal') {
    stored.salespeople = stored.salespeople.map((person) => ({ ...person, principalId: 'foreign-principal' }));
  }
  return stored;
};

const crmListingDecision = (scenario: ReaderScenario, broad: boolean) =>
  makeTestAccessDecision({
    answers: {
      'demo.crm.api-records.read': {
        outcome: scenario.readOutcome ?? (scenario.readable === false ? 'DENIED' : 'ALLOWED'),
        predicate:
          scenario.predicate ??
          (broad
            ? { groups: [] }
            : {
                groups: [
                  {
                    clauses: [
                      {
                        conditions: [
                          {
                            _tag: 'AssignedTo',
                            holder: {
                              _tag: 'Principal',
                              principalId: AccessPrincipalIdSchema.make(scope.principalId),
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              }),
      },
    },
  });

const assertSearchProjectionSql = (
  sql: string,
  params: readonly unknown[],
  predicate: ListAccessPredicate | undefined,
) => {
  expect(sql).toContain('"demo_crm"."crm_states"');
  expect(sql).toContain("c - 'note' - 'partyRef' - 'segment'");
  expect(sql).toContain("contact - 'note'");
  expect(sql).toContain('jsonb_strip_nulls');
  for (const condition of predicate?.groups.flatMap(({ clauses }) => clauses.flatMap(({ conditions }) => conditions)) ??
    []) {
    if (condition._tag === 'RecordKeyIn') {
      expect(sql).toContain(' in (');
      for (const recordKey of condition.recordKeys) {
        expect(params).toContain(recordKey);
      }
    }
  }
};
const assertDeniedSearch = (outcome: Exit.Exit<unknown, unknown>, scenario: ReaderScenario) => {
  expect(Exit.isFailure(outcome)).toBe(true);
  if (Exit.isFailure(outcome)) {
    const failure = Option.getOrUndefined(Cause.findErrorOption(outcome.cause));
    expect(
      scenario.readOutcome === 'UNAVAILABLE'
        ? Schema.is(ReadHandlerUnavailable)(failure)
        : Schema.is(ReadPermissionDenied)(failure),
    ).toBe(true);
  }
};
const searchMustFail = (scenario: ReaderScenario) =>
  scenario.entrypointAllowed === false ||
  scenario.readable === false ||
  scenario.readOutcome !== undefined ||
  scenario.missingPredicate === true;

const runGovernedProvider = Effect.fn('Crm.testGovernedSearch')(function* runGovernedProvider(
  scenario: ReaderScenario,
) {
  const selectedCompanyId = scenario.selectedCompanyId ?? companyId;
  const encoded = yield* Schema.encodeEffect(CrmStateSchema)(scenario.currentState ?? state);
  const stored = ownerStateFor(encoded, scenario, scope.principalId);
  const docs = yield* buildSearchDocuments({
    ...snapshot,
    companies: [{ legalEntityId: companyId, state: scenario.indexState ?? state }],
  });
  const store = makeInMemoryCoreSearchProjectionStore();
  for (const document of docs) {
    yield* store.apply({ document, kind: 'upsert' }, context);
  }
  const search = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
  const principal = {
    ...scope,
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'session:crm-search',
    authMethod: 'session' as const,
    legalEntityId: selectedCompanyId,
  };
  const query =
    scenario.query ??
    (scenario.resourceType === 'demo.crm.client' ? 'info@pekarna.example.test' : 'jiri.novotny@example.test');
  // Prove the query really matches the stored index before testing the independent CRM authorization boundary.
  const indexed = yield* search.search(
    {
      includeArchived: false,
      includeRelevance: true,
      moduleId: 'demo.crm',
      query: crmSearchQuery(query),
      resourceType: scenario.resourceType,
      selectedLegalEntityId: selectedCompanyId,
      tenantId: scope.tenantId,
    },
    principal,
  );
  expect(indexed.length).toBe(scenario.indexCount ?? (selectedCompanyId === companyId ? 1 : 0));
  if (scenario.expectedIndexScore !== undefined) {
    expect(indexed.map((hit) => hit.relevance?.score)).toEqual([scenario.expectedIndexScore]);
  }
  expect(JSON.stringify(indexed)).not.toMatch(/@|777111|606333|private/u);
  let ownerLoads = 0;
  const harness = yield* makeReadTestHarness({
    access: {
      'demo.crm.search-clients.read': scenario.entrypointAllowed === false ? 'denied' : 'allowed',
      'demo.crm.search-contacts.read': scenario.entrypointAllowed === false ? 'denied' : 'allowed',
    },
    compositionRevision: 'a'.repeat(64),
    executeOwnerQuery: ({ params, scope: sqlScope, sql }) => {
      expect(sqlScope).toEqual({ legalEntityId: selectedCompanyId, tenantId: scope.tenantId });
      ownerLoads += 1;
      assertSearchProjectionSql(sql, params, scenario.predicate);
      expect(params).toContain(scope.tenantId);
      expect(params).toContain(selectedCompanyId);
      return Effect.succeed(
        scenario.ownerSnapshot === 'missing' || selectedCompanyId !== companyId
          ? []
          : [{ legalEntityId: selectedCompanyId, state: stored, tenantId: scope.tenantId }],
      );
    },
    operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z')),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: crmRegistration,
    permissionDecision: 'allowed',
    scope: principal,
  });
  Object.assign(Context.get(yield* Layer.build(harness.layer), ContextAccess), {
    contextPermissions: () => Effect.die('Retired permission authority was invoked'),
    modules: () => Effect.die('Retired module authority was invoked'),
    resources: () => Effect.die('Retired resource authority was invoked'),
  });
  let { broad } = scenario;
  const gate = makeTestAccessDecision({ defaultAnswer: { outcome: 'DENIED' } });
  const ownerGate = {
    ...gate,
    list: (question: Parameters<typeof gate.list>[0]) => {
      expect(question.carrier).toBe(recordsRead.descriptor);
      expect(question.scope.principalId).toBe(scope.principalId);
      expect(question.scope.legalEntityId).toBe(selectedCompanyId);
      const current = crmListingDecision(scenario, broad);
      return current
        .list(question)
        .pipe(Effect.map((answer) => (scenario.missingPredicate === true ? { decision: answer.decision } : answer)));
    },
  };
  const input = { input: { query }, principal, transport: { correlationId: scope.correlationId } };
  const checkCurrentResult = (result: ClientsProviderResponse | ContactsProviderResponse) => {
    if (scenario.expectedTitle !== undefined) {
      expect(result.map((hit) => hit.title)).toEqual([scenario.expectedTitle]);
    }
    if (scenario.expectedScore !== undefined) {
      expect(result.map((hit) => hit.relevance?.score)).toEqual([scenario.expectedScore]);
    }
    return checkResult(result, true);
  };
  const run =
    scenario.resourceType === 'demo.crm.client'
      ? harness.runtime.runRead({ ...input, registration: clientsRead }).pipe(Effect.map(checkCurrentResult))
      : harness.runtime.runRead({ ...input, registration: contactsRead }).pipe(Effect.map(checkCurrentResult));
  let indexReads = 0;
  const invoke = run.pipe(
    Effect.provide(harness.layer),
    Effect.provideService(AccessDecisionGate, ownerGate),
    Effect.provideService(CoreSearchQueryRuntime, {
      search: (searchInput, trustedScope) => {
        indexReads += 1;
        expect(harness.snapshot().statements.some((statement) => /^commit$/iu.test(statement))).toBe(true);
        return search.search(searchInput, trustedScope);
      },
    }),
  );
  const outcome = yield* Effect.exit(invoke);
  const denied = searchMustFail(scenario);
  if (!denied && Exit.isFailure(outcome)) {
    yield* Effect.failCause(outcome.cause);
    return;
  }
  expect(ownerLoads).toBe(Number(!denied));
  expect(indexReads).toBe(Number(!denied));
  expect(Exit.isSuccess(outcome)).toBe(!denied);
  if (denied) {
    assertDeniedSearch(outcome, scenario);
  }
  if (Exit.isSuccess(outcome)) {
    expect(outcome.value).toBe(scenario.expectedCount);
    expect(harness.snapshot().evidenceWrites).toBe(1);
    expect(
      scenario.resourceType === 'demo.crm.client'
        ? clientsRead.descriptor.evidencePolicy.captureMode
        : contactsRead.descriptor.evidencePolicy.captureMode,
    ).toBe('metadata_only');
  }
  if (scenario.refreshBroadGrant === true) {
    // The same runtime, principal, state and positive index must observe both a new grant and its revocation.
    broad = true;
    expect(yield* invoke).toBe(1);
    broad = false;
    expect(yield* invoke).toBe(0);
    expect(ownerLoads).toBe(3);
    expect(indexReads).toBe(3);
    expect(harness.snapshot().evidenceWrites).toBe(3);
  }
});

it.effect('canonical owner projection authorizes broad and assigned-only search without generic resource.read', () =>
  Effect.forEach(
    [
      { assigned: true, broad: true, expectedCount: 1 },
      { assigned: true, broad: false, expectedCount: 1 },
      { assigned: true, broad: false, expectedCount: 0, readable: false },
      {
        assigned: true,
        broad: true,
        entrypointAllowed: false,
        expectedCount: null,
      },
      { assigned: false, broad: false, expectedCount: 0 },
    ] as const,
    (scenario) =>
      Effect.forEach(
        ['demo.crm.client', 'demo.crm.contact'] as const,
        (resourceType) => runGovernedProvider({ ...scenario, resourceType }),
        { concurrency: 1, discard: true },
      ),
    { concurrency: 1, discard: true },
  ).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

for (const resourceType of ['demo.crm.client', 'demo.crm.contact'] as const) {
  for (const ownerSnapshot of [
    'missing',
    'deleted',
    'archived-client',
    'client-archived-at',
    'assignment-removed',
    'missing-salesperson',
    'inactive-salesperson',
    'different-principal',
  ] as const) {
    it.effect(`${resourceType}: positive index cannot outlive canonical owner visibility (${ownerSnapshot})`, () =>
      runGovernedProvider({ assigned: true, broad: false, expectedCount: 0, ownerSnapshot, resourceType }).pipe(
        Effect.scoped,
        Effect.provide(NodeCrypto.layer),
      ),
    );
  }
}
for (const ownerSnapshot of [
  'archived-contact',
  'contact-archived-at',
  'contact-withdrawn',
  'orphan-contact',
] as const) {
  it.effect(`contact: current active parent and contact are required (${ownerSnapshot})`, () =>
    runGovernedProvider({
      assigned: true,
      broad: false,
      expectedCount: 0,
      ownerSnapshot,
      resourceType: 'demo.crm.contact',
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );
}

it.effect('governed email/phone lookup keeps company isolation and returns no matched-value evidence', () =>
  Effect.forEach(
    [
      {
        queries: [
          'Železárny Hanák',
          'zelezarny',
          '12345678',
          '1234',
          'info@pekarna.example.test',
          'INFO@PEKARNA.EXAMPLE.TEST',
          'info@pekarna',
          '+420 (777) 111-222',
          '420777111222',
          '777111222',
          '777 111',
          '+420 777',
        ],
        resourceType: 'demo.crm.client',
      },
      {
        queries: [
          'Jiří Novotný',
          'jiri',
          'jiri.novotny@example.test',
          'JIRI.NOVOTNY@EXAMPLE.TEST',
          'jiri.novotny@exam',
          '+420 606 333 444',
          '420606333444',
          '606333444',
          '606-333',
          '+420 606',
        ],
        resourceType: 'demo.crm.contact',
      },
    ] as const,
    ({ queries, resourceType }) =>
      Effect.forEach(
        queries,
        (query) =>
          Effect.forEach(
            [companyId, otherCompanyId],
            (selectedCompanyId) =>
              runGovernedProvider({
                assigned: true,
                broad: false,
                expectedCount: selectedCompanyId === companyId ? 1 : 0,
                query,
                resourceType,
                selectedCompanyId,
              }),
            { concurrency: 1, discard: true },
          ),
        { concurrency: 1, discard: true },
      ),
    { concurrency: 1, discard: true },
  ).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

const metadataState: typeof state = {
  ...state,
  clients: {
    ...state.clients,
    contacts: state.clients.contacts.map((contact) => ({ ...contact, role: 'Vedoucí nákupu' })),
    items: state.clients.items.map((client) => ({
      ...client,
      address: 'Dlouhá 42, Brno',
      vatNo: 'CZ12345678',
      website: 'https://hanak.example.test',
    })),
  },
};

const StaleFieldSchema = Schema.Literals(['email', 'name', 'phone']);
type StaleField = typeof StaleFieldSchema.Type;
const StaleReplacementSchema = Schema.Literals(['malformed', 'removed', 'replaced']);
type StaleReplacement = typeof StaleReplacementSchema.Type;
const staleIndexName = 'Původní Jedinec';

const staleFieldValue = (
  row: { readonly email?: string; readonly phone?: string },
  field: 'email' | 'phone',
  replacement: Exclude<StaleReplacement, 'removed'>,
): string => {
  if (replacement === 'malformed') {
    return field === 'email' ? `note ${row.email}` : `call ${row.phone}`;
  }
  return field === 'email' ? 'replacement@example.test' : '+420 222 444 555';
};

const replaceStaleField = <A extends { readonly email?: string; readonly name: string; readonly phone?: string }>(
  row: A,
  field: StaleField,
  replacement: StaleReplacement,
): A => {
  if (replacement === 'removed') {
    const next = { ...row };
    Reflect.deleteProperty(next, field);
    return next;
  }
  if (field === 'name') {
    return { ...row, name: 'Nový název' };
  }
  return { ...row, [field]: staleFieldValue(row, field, replacement) };
};

const staleQuery = (client: boolean, field: StaleField): string => {
  if (field === 'name') {
    return client ? 'hanak' : 'jedinec';
  }
  if (field === 'email') {
    return client ? 'info@pekarna.example.test' : 'jiri.novotny@example.test';
  }
  return client ? '+420 (777) 111-222' : '606-333';
};

const staleNameIndex = (): typeof state => ({
  ...state,
  clients: {
    ...state.clients,
    contacts: state.clients.contacts.map((row) => ({ ...row, name: staleIndexName })),
  },
});

const metadataQueries = {
  address: 'Dlouhá 42',
  vatNo: 'CZ12345678',
  website: 'hanak.example.test',
} as const;

for (const resourceType of ['demo.crm.client', 'demo.crm.contact'] as const) {
  const client = resourceType === 'demo.crm.client';
  for (const field of ['email', 'phone', 'name'] as const) {
    for (const replacement of ['removed', 'replaced', 'malformed'] as const) {
      if (field === 'name' && replacement !== 'replaced') {
        continue;
      }
      it.effect(`${resourceType}: same active ID cannot match stale ${field} (${replacement})`, () => {
        // The fixture contact name shares its tokens with the retained email, so the stale-name case must
        // publish a distinct index name; otherwise the current email would legitimately answer the query.
        const indexState = field === 'name' && !client ? staleNameIndex() : undefined;
        return runGovernedProvider({
          assigned: true,
          broad: false,
          currentState: {
            ...state,
            clients: {
              ...state.clients,
              contacts: client
                ? state.clients.contacts
                : state.clients.contacts.map((row) => replaceStaleField(row, field, replacement)),
              items: client
                ? state.clients.items.map((row) => replaceStaleField(row, field, replacement))
                : state.clients.items,
            },
          },
          expectedCount: 0,
          indexState,
          query: staleQuery(client, field),
          resourceType,
        }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer));
      });
    }
  }
  it.effect(`${resourceType}: retained email evidence returns the current title, not the stale index title`, () =>
    runGovernedProvider({
      assigned: true,
      broad: false,
      currentState: {
        ...state,
        clients: {
          ...state.clients,
          contacts: client
            ? state.clients.contacts
            : state.clients.contacts.map((row) => ({ ...row, name: 'Nový kontakt' })),
          items: client ? state.clients.items.map((row) => ({ ...row, name: 'Nový klient' })) : state.clients.items,
        },
      },
      expectedCount: 1,
      expectedTitle: client ? 'Nový klient' : 'Nový kontakt',
      resourceType,
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );
}

it.effect(
  'same-owner organization metadata and permitted contact role/parent name obey canonical assignment visibility',
  () =>
    Effect.forEach(
      [
        { queries: ['CZ12345678', 'Dlouhá 42', 'dlouha', 'hanak.example.test'], resourceType: 'demo.crm.client' },
        { queries: ['Vedoucí nákupu', 'nakupu', 'Železárny Hanák'], resourceType: 'demo.crm.contact' },
      ] as const,
      ({ queries, resourceType }) =>
        Effect.forEach(
          queries,
          (query) =>
            Effect.forEach(
              [true, false],
              (assigned) =>
                runGovernedProvider({
                  assigned,
                  broad: false,
                  currentState: metadataState,
                  expectedCount: assigned ? 1 : 0,
                  indexState: metadataState,
                  query,
                  resourceType,
                }),
              { concurrency: 1, discard: true },
            ),
          { concurrency: 1, discard: true },
        ),
      { concurrency: 1, discard: true },
    ).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.effect('contact cannot be located by a withdrawn parent name or changed job role before reindexing', () =>
  Effect.forEach(
    [
      {
        query: 'hanak',
        state: {
          ...metadataState,
          clients: {
            ...metadataState.clients,
            items: metadataState.clients.items.map((row) => ({ ...row, name: 'Nový klient' })),
          },
        },
      },
      {
        query: 'nakupu',
        state: {
          ...metadataState,
          clients: {
            ...metadataState.clients,
            contacts: metadataState.clients.contacts.map((row) => ({ ...row, role: 'Jednatel' })),
          },
        },
      },
    ],
    (scenario) =>
      runGovernedProvider({
        assigned: true,
        broad: false,
        currentState: scenario.state,
        expectedCount: 0,
        indexState: metadataState,
        query: scenario.query,
        resourceType: 'demo.crm.contact',
      }),
    { concurrency: 1, discard: true },
  ).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.effect('client metadata removal is rechecked on the same active current ID', () =>
  Effect.forEach(
    ['vatNo', 'address', 'website'] as const,
    (field) =>
      runGovernedProvider({
        assigned: true,
        broad: true,
        currentState: {
          ...metadataState,
          clients: {
            ...metadataState.clients,
            items: metadataState.clients.items.map((row) => {
              const next = { ...row };
              Reflect.deleteProperty(next, field);
              return next;
            }),
          },
        },
        expectedCount: 0,
        indexState: metadataState,
        query: metadataQueries[field],
        resourceType: 'demo.crm.client',
      }),
    { concurrency: 1, discard: true },
  ).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.effect('current rematch requires every normalized token within approved current record evidence', () =>
  Effect.gen(function* checkCurrentTokens() {
    const documents = yield* buildSearchDocuments({
      ...snapshot,
      companies: [{ legalEntityId: companyId, state: metadataState }],
    });
    const gateway: CoreSearchQueryRuntime['Service'] = {
      search: () => Effect.succeed(documents.map((document) => ({ ...document, title: 'Stale index title' }))),
    };
    for (const [query, expected] of [
      ['NÁKUPU hanak jiri', 1],
      ['nakupu missing jiri', 0],
    ] as const) {
      const hits = yield* loadCrmSearch(scope, {
        query,
        resourceType: 'demo.crm.contact',
        visible: metadataState,
      }).pipe(Effect.provideService(CoreSearchQueryRuntime, gateway));
      expect(hits.length).toBe(expected);
      if (expected === 1) {
        expect(hits.map((hit) => hit.title)).toEqual(['Jiří Novotný']);
        checkResult(hits);
      }
    }
    const withdrawnRole = {
      ...metadataState,
      clients: {
        ...metadataState.clients,
        contacts: metadataState.clients.contacts.map((contact) => ({ ...contact, role: 'Jednatel' })),
      },
    };
    expect(
      yield* loadCrmSearch(scope, {
        query: 'nakupu hanak jiri',
        resourceType: 'demo.crm.contact',
        visible: withdrawnRole,
      }).pipe(Effect.provideService(CoreSearchQueryRuntime, gateway)),
    ).toEqual([]);
    expect(
      Exit.isFailure(
        yield* loadCrmSearch(scope, {
          query: '\u0301',
          resourceType: 'demo.crm.contact',
          visible: metadataState,
        }).pipe(
          Effect.provideService(CoreSearchQueryRuntime, {
            search: () => Effect.die('Normalized-empty input must fail before index access'),
          }),
          Effect.exit,
        ),
      ),
    ).toBe(true);
  }),
);

it('public request schemas reject normalized-empty and overlength queries without changing valid phone input', () => {
  for (const schema of [ClientsProviderRequestSchema, ContactsProviderRequestSchema]) {
    for (const query of [' ', '\u0301', '\u0301 \u030C', 'x'.repeat(201)]) {
      expect(Schema.is(schema)({ query })).toBe(false);
    }
    for (const query of ['x', 'x'.repeat(200), 'Železárny', '+420 (777) 111-222']) {
      expect(Schema.is(schema)({ query })).toBe(true);
    }
  }
});

for (const resourceType of ['demo.crm.client', 'demo.crm.contact'] as const) {
  const client = resourceType === 'demo.crm.client';
  it.effect(`${resourceType}: recomputes a high stale-title score from the authorized current title`, () => {
    const indexState: typeof state = {
      ...state,
      clients: {
        ...state.clients,
        contacts: state.clients.contacts.map((contact) => ({ ...contact, name: 'Nákupčí', role: 'Nákupčí' })),
        items: state.clients.items.map((row) => ({ ...row, name: '12345678' })),
      },
    };
    const currentState: typeof state = {
      ...indexState,
      clients: {
        ...indexState.clients,
        contacts: indexState.clients.contacts.map((contact) => ({ ...contact, name: 'Nový kontakt' })),
        items: indexState.clients.items.map((row) => ({ ...row, name: 'Nový klient' })),
      },
    };
    return runGovernedProvider({
      assigned: true,
      broad: false,
      currentState,
      expectedCount: 1,
      expectedIndexScore: 900,
      expectedScore: 100,
      expectedTitle: client ? 'Nový klient' : 'Nový kontakt',
      indexState,
      query: client ? '12345678' : 'Nákupčí',
      resourceType,
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer));
  });
  it.effect(`${resourceType}: fresh owner grants and revocations take effect without changing the positive index`, () =>
    runGovernedProvider({
      assigned: false,
      broad: false,
      expectedCount: 0,
      refreshBroadGrant: true,
      resourceType,
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );
}

it.effect('legacy CRM helper callers omit relevance unless explicitly requested; stale Core scores never leak', () =>
  Effect.gen(function* legacyRelevance() {
    const documents = yield* buildSearchDocuments(snapshot);
    for (const resourceType of ['demo.crm.client', 'demo.crm.contact'] as const) {
      const query = resourceType === 'demo.crm.client' ? 'hanak' : 'jiri';
      const gateway: CoreSearchQueryRuntime['Service'] = {
        search: (input) => {
          expect(input).not.toHaveProperty('includeRelevance');
          return Effect.succeed(
            documents.map((document) => ({ ...document, relevance: { score: 1000, version: '1' as const } })),
          );
        },
      };
      for (const includeRelevance of [undefined, false]) {
        const request = { query, resourceType, visible: state };
        const hits = yield* loadCrmSearch(
          scope,
          includeRelevance === undefined ? request : { ...request, includeRelevance },
        ).pipe(Effect.provideService(CoreSearchQueryRuntime, gateway));
        expect(checkResult(hits)).toBe(1);
      }
    }
  }),
);

it('CRM response contracts accept old hits and only the optional public relevance v1 shape', () => {
  for (const [schema, resourceType] of [
    [ClientsProviderResponseSchema, 'demo.crm.client'],
    [ContactsProviderResponseSchema, 'demo.crm.contact'],
  ] as const) {
    const hit = {
      ref: { moduleId: 'demo.crm', resourceId: 'record-1', resourceType, tenantId: scope.tenantId },
      selectedLegalEntityId: companyId,
      title: 'Current public title',
    };
    expect(Schema.is(schema)([hit])).toBe(true);
    for (const score of [0, 100, 1000]) {
      expect(Schema.is(schema)([{ ...hit, relevance: { score, version: '1' } }])).toBe(true);
    }
    for (const relevance of [
      { score: -1, version: '1' },
      { score: 1001, version: '1' },
      { score: 1.5, version: '1' },
      { score: 100, version: '2' },
    ]) {
      expect(Schema.is(schema)([{ ...hit, relevance }])).toBe(false);
    }
  }
});

it.effect('governed lookup never searches notes or strips arbitrary free text into a phone query', () =>
  Effect.forEach(
    [
      'private account note',
      'private contact note',
      'note-client@example.test',
      'note-contact@example.test',
      '+420 999 888 777',
      '999888666',
      'call 777 111 222',
      'note jiri.novotny@example.test',
    ],
    (query) =>
      Effect.forEach(
        ['demo.crm.client', 'demo.crm.contact'] as const,
        (resourceType) =>
          runGovernedProvider({
            assigned: true,
            broad: true,
            expectedCount: 0,
            indexCount: 0,
            query,
            resourceType,
          }),
        { concurrency: 1, discard: true },
      ),
    { concurrency: 1, discard: true },
  ).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

const target = (key: string) => ({
  _tag: 'RecordKeyIn' as const,
  recordKeys: [RecordKeySchema.make(key)] as const,
});

it.effect('actual CRM search records LIST keeps full AND/OR target intersection without widening assigned reach', () =>
  Effect.gen(function* recordPredicates() {
    const assigned = {
      _tag: 'AssignedTo' as const,
      holder: { _tag: 'Principal' as const, principalId: AccessPrincipalIdSchema.make(scope.principalId) },
    };
    for (const resourceType of ['demo.crm.client', 'demo.crm.contact'] as const) {
      for (const [predicate, expectedCount] of [
        [
          { groups: [{ clauses: [{ conditions: [assigned] }] }, { clauses: [{ conditions: [target('client-1')] }] }] },
          1,
        ],
        [
          { groups: [{ clauses: [{ conditions: [assigned] }] }, { clauses: [{ conditions: [target('missing')] }] }] },
          0,
        ],
        [{ groups: [{ clauses: [{ conditions: [target('missing')] }, { conditions: [target('client-1')] }] }] }, 1],
        [
          {
            groups: [
              { clauses: [{ conditions: [{ _tag: 'AllInScope' }] }] },
              { clauses: [{ conditions: [target('missing')] }] },
            ],
          },
          0,
        ],
        [
          {
            groups: [
              {
                clauses: [
                  {
                    conditions: [
                      {
                        _tag: 'AmountWithinCeiling',
                        ceiling: { currency: CurrencyCodeSchema.make('CZK'), limitMinor: 10 },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          0,
        ],
      ] as const) {
        yield* runGovernedProvider({ assigned: true, broad: false, expectedCount, predicate, resourceType });
      }
      for (const readOutcome of ['DENIED', 'UNAVAILABLE'] as const) {
        yield* runGovernedProvider({ assigned: true, broad: true, expectedCount: null, readOutcome, resourceType });
      }
      yield* runGovernedProvider({
        assigned: true,
        broad: true,
        expectedCount: null,
        missingPredicate: true,
        resourceType,
      });
    }
    for (const malformed of [
      { groups: [{ clauses: [] }] },
      { groups: [{ clauses: [{ conditions: [] }] }] },
      { groups: [], unsupported: true },
    ]) {
      expect(Schema.isSchemaError(yield* parseCrmSearchPredicate(malformed).pipe(Effect.flip))).toBe(true);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);
