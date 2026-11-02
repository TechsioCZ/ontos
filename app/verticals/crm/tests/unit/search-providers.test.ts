import { CoreSearchProjectionHitSchema, CoreSearchQueryRuntime, ContextAccess } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { Context, Effect, Exit, Layer, Schema } from 'effect';
import type { ContextAccessService } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { CrmStateSchema } from '../../shared/domain/state.ts';
import { clientsRead, loadCrmSearch } from '../../src/search/clients.provider.ts';
import { contactsRead } from '../../src/search/contacts.provider.ts';
import { expect, it } from 'effect-rstest';
import { ClientsProviderResponseSchema } from '../../shared/apis/clients-search.ts';
import { ContactsProviderResponseSchema } from '../../shared/apis/contacts-search.ts';
import { buildSearchDocuments } from '../../src/services/search-projection.service.ts';
import { companyId, otherCompanyId, scope, snapshot, state } from './search-fixtures.ts';

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
  readonly expectedCount: number | null;
  readonly resourceType: 'demo.crm.client' | 'demo.crm.contact';
}
const runGovernedProvider = Effect.fn('Crm.testGovernedSearch')(function* runGovernedProvider(
  scenario: ReaderScenario,
) {
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
  const principal = {
    ...scope,
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'session:crm-search',
    authMethod: 'session' as const,
  };
  const harness = yield* makeReadTestHarness({
    compositionRevision: 'a'.repeat(64),
    executeOwnerQuery: ({ scope: sqlScope, sql }) => {
      expect(sqlScope).toEqual({ legalEntityId: companyId, tenantId: scope.tenantId });
      return sql.includes('"demo_crm"."crm_states"')
        ? Effect.succeed([{ revision: 1, state: stored }])
        : Effect.die(`Unexpected owner query: ${sql}`);
    },
    operationTime: new Date('2026-01-01T00:00:00.000Z'),
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: 'allowed',
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
  const input = { input: { query: 'name' }, principal, transport: { correlationId: scope.correlationId } };
  const run =
    scenario.resourceType === 'demo.crm.client'
      ? harness.runtime.runRead({ ...input, registration: clientsRead }).pipe(Effect.map((result) => result.length))
      : harness.runtime.runRead({ ...input, registration: contactsRead }).pipe(Effect.map((result) => result.length));
  const outcome = yield* run.pipe(
    Effect.provide(harness.layer),
    Effect.provideService(CoreSearchQueryRuntime, {
      search: () => Effect.succeed(docs.filter((doc) => doc.ref.resourceType === scenario.resourceType)),
    }),
    Effect.exit,
  );
  expect(rowChecks).toBe(scenario.expectedCount === 0 ? 0 : 1);
  expect(Exit.isSuccess(outcome)).toBe(scenario.expectedCount !== null);
  if (Exit.isSuccess(outcome)) {
    expect(outcome.value).toBe(scenario.expectedCount);
  }
});

it.effect(
  'governed providers allow broad readers but deny assigned rows without an available resource entitlement',
  () =>
    Effect.forEach(
      [
        { assigned: true, broad: true, decision: 'allowed', expectedCount: 1 },
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
