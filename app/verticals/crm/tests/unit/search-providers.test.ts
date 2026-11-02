import {
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  ContextAccess,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { Context, Effect, Exit, Layer, Schema } from 'effect';
import type { ContextAccessService } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { CrmStateSchema } from '../../shared/domain/state.ts';
import { crmSearchQuery } from '../../shared/domain/search-contact-classification.ts';
import { clientsRead, loadCrmSearch } from '../../src/search/clients.provider.ts';
import { contactsRead } from '../../src/search/contacts.provider.ts';
import { expect, it } from 'effect-rstest';
import { ClientsProviderResponseSchema } from '../../shared/apis/clients-search.ts';
import type { ClientsProviderResponse } from '../../shared/apis/clients-search.ts';
import { ContactsProviderResponseSchema } from '../../shared/apis/contacts-search.ts';
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
  readonly decision: 'allowed' | 'denied' | 'unavailable';
  readonly entrypointAllowed?: boolean;
  readonly expectedCount: number | null;
  readonly indexCount?: number;
  readonly query?: string;
  readonly readable?: boolean;
  readonly resourceType: 'demo.crm.client' | 'demo.crm.contact';
  readonly selectedCompanyId?: string;
}
const checkResult = (result: ClientsProviderResponse | ContactsProviderResponse) => {
  for (const hit of result) {
    expect(new Set(Object.keys(hit))).toEqual(new Set(['ref', 'selectedLegalEntityId', 'title']));
  }
  expect(JSON.stringify(result)).not.toMatch(/@|777111|606333|private/u);
  return result.length;
};

const runGovernedProvider = Effect.fn('Crm.testGovernedSearch')(function* runGovernedProvider(
  scenario: ReaderScenario,
) {
  const selectedCompanyId = scenario.selectedCompanyId ?? companyId;
  const encoded = yield* Schema.encodeEffect(CrmStateSchema)(state);
  const stored = {
    ...encoded,
    clients: {
      ...encoded.clients,
      items: encoded.clients.items.map((client) => ({
        ...client,
        ownerSalespersonId: scenario.assigned ? 'rep-1' : 'another-rep',
      })),
    },
    salespeople: [{ active: true, id: 'rep-1', name: 'Assigned salesperson', principalId: scope.principalId }],
  };
  const docs = yield* buildSearchDocuments(snapshot);
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
      moduleId: 'demo.crm',
      query: crmSearchQuery(query),
      resourceType: scenario.resourceType,
      selectedLegalEntityId: selectedCompanyId,
      tenantId: scope.tenantId,
    },
    principal,
  );
  expect(indexed.length).toBe(scenario.indexCount ?? (selectedCompanyId === companyId ? 1 : 0));
  expect(JSON.stringify(indexed)).not.toMatch(/@|777111|606333|private/u);
  const harness = yield* makeReadTestHarness({
    compositionRevision: 'a'.repeat(64),
    executeOwnerQuery: ({ scope: sqlScope, sql }) => {
      expect(sqlScope).toEqual({ legalEntityId: selectedCompanyId, tenantId: scope.tenantId });
      return sql.includes('"demo_crm"."crm_states"')
        ? Effect.succeed([{ revision: 1, state: stored }])
        : Effect.die(`Unexpected owner query: ${sql}`);
    },
    operationTime: new Date('2026-01-01T00:00:00.000Z'),
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: scenario.entrypointAllowed === false ? 'denied' : 'allowed',
    scope: principal,
  });
  const services = yield* Layer.build(harness.layer);
  const access = Context.get(services, ContextAccess);
  let rowChecks = 0;
  // Mutate only this harness's boundary fake; its real ReadRuntime retains the exact same object.
  const decisions: Pick<ContextAccessService, 'contextPermissions' | 'resources'> = {
    contextPermissions: ({ targets }) =>
      Effect.succeed(
        targets.map(({ moduleId, permission }) => ({
          decision:
            scenario.readable !== false &&
            permission === (scenario.broad ? 'demo.crm.read_all' : 'demo.crm.read_assigned')
              ? ('allowed' as const)
              : ('denied' as const),
          key: `${moduleId}:${permission}`,
        })),
      ),
    resources: ({ resources }) =>
      Effect.sync(() => {
        rowChecks += resources.length;
        return resources.map((resource) => ({
          decision: scenario.decision,
          key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
        }));
      }),
  };
  Object.assign(access, decisions);
  const input = { input: { query }, principal, transport: { correlationId: scope.correlationId } };
  const run =
    scenario.resourceType === 'demo.crm.client'
      ? harness.runtime.runRead({ ...input, registration: clientsRead }).pipe(Effect.map(checkResult))
      : harness.runtime.runRead({ ...input, registration: contactsRead }).pipe(Effect.map(checkResult));
  const outcome = yield* run.pipe(
    Effect.provide(harness.layer),
    Effect.provideService(CoreSearchQueryRuntime, search),
    Effect.exit,
  );
  expect(rowChecks).toBe(scenario.expectedCount === 0 || scenario.entrypointAllowed === false ? 0 : 1);
  expect(Exit.isSuccess(outcome)).toBe(scenario.expectedCount !== null);
  if (Exit.isSuccess(outcome)) {
    expect(outcome.value).toBe(scenario.expectedCount);
    expect(harness.snapshot().evidenceWrites).toBe(1);
    expect(
      scenario.resourceType === 'demo.crm.client'
        ? clientsRead.descriptor.evidencePolicy.captureMode
        : contactsRead.descriptor.evidencePolicy.captureMode,
    ).toBe('metadata_only');
  }
});

it.effect(
  'governed providers allow broad readers but deny assigned rows without an available resource entitlement',
  () =>
    Effect.forEach(
      [
        { assigned: true, broad: true, decision: 'allowed', expectedCount: 1 },
        { assigned: true, broad: false, decision: 'allowed', expectedCount: 1 },
        { assigned: true, broad: false, decision: 'allowed', expectedCount: 0, readable: false },
        {
          assigned: true,
          broad: true,
          decision: 'allowed',
          entrypointAllowed: false,
          expectedCount: null,
        },
        { assigned: true, broad: false, decision: 'denied', expectedCount: null },
        { assigned: true, broad: false, decision: 'unavailable', expectedCount: null },
        { assigned: false, broad: false, decision: 'allowed', expectedCount: 0 },
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
                broad: true,
                decision: 'allowed',
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
            decision: 'allowed',
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
