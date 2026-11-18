// @rstest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  networkIdle,
  networkQuietExcept,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
  streamingBrowserNetwork,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { HttpApi, HttpApiGroup } from 'effect/http-api';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { DateTime, Deferred, Effect, Layer, Schema } from 'effect';
import { moduleChangeEvent, pageDataScopeKey } from '@app/shared-contracts/page-data';
import {
  CustomerListApi,
  CustomerListForbiddenProblemSchema,
  CustomerListItemSchema,
} from '../../shared/apis/customer-list.ts';
import {
  CounterpartyReadApi,
  CounterpartyReadForbiddenProblemSchema,
  CounterpartyReadResponseSchema,
} from '../../shared/apis/counterparty-read.ts';
import { PartyDetailApi, PartyDetailForbiddenProblemSchema } from '../../shared/apis/party-detail.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import type { CustomerListRequest, CustomerListResponse } from '../../shared/apis/customer-list.ts';
import type { CounterpartyReadRequest, CounterpartyReadResponse } from '../../shared/apis/counterparty-read.ts';
import type { PartyDetailRequest, PartyDetailResponse } from '../../shared/apis/party-detail.ts';
import { PartyContactPointsApi } from '../../shared/apis/party-contact-points.ts';
import type { PartyContactPointsRequest } from '../../shared/apis/party-contact-points.ts';
import { PartyOfficialIdentifierHistoryApi } from '../../shared/apis/party-official-identifier-history.ts';
import type { PartyOfficialIdentifierHistoryRequest } from '../../shared/apis/party-official-identifier-history.ts';
import { partyRegistryCommandsApi, PartyCommandSchemaErrorMiddleware } from '../../shared/command-api.ts';
import { partyCommandSchemaErrorLive } from '../../api/party-command-problems.ts';
import {
  customerDetailData,
  customerDetailIntent,
  customersData,
  customersQuery,
  loadCustomerDetailInto,
  loadCustomerDetailByRef,
  preloadCustomerDetails,
  saveCustomerFact,
  useCustomerDetailSelection,
  usePrefetchCustomerDetails,
} from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';
import type { CustomerDetailSnapshot } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const counterpartyId = '30000000-0000-4000-8000-000000000001';
const instant = '2026-10-15T10:00:00.000Z';
const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: partyId,
  resourceType: 'party.registry.party' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const customer = Schema.decodeSync(CustomerListItemSchema)({
  city: null,
  companyId: null,
  counterpartyId,
  counterpartyRef,
  createdAt: instant,
  displayName: 'Before',
  email: null,
  partyId,
  partyRef,
  partyRevision: 1,
  phone: null,
  status: 'ACTIVE',
  vatId: null,
});
const party = Schema.decodeSync(PartySchema)({
  archivedAt: null,
  businessName: 'Before',
  createdAt: instant,
  displayName: 'Before',
  firstName: null,
  lastName: null,
  partyRef,
  partyType: 'ORGANIZATION',
  revision: 1,
  updatedAt: instant,
});
const snapshot: CustomerDetailSnapshot = {
  contacts: { status: 'ready', value: { items: [] } },
  counterparty: Schema.decodeSync(CounterpartyReadResponseSchema)({
    counterpartyRef,
    createdAt: instant,
    currentRoles: [],
    legalEntityRef: {
      moduleId: 'core.identity',
      resourceId: '60000000-0000-4000-8000-000000000001',
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    party: {
      archived: false,
      canonicalPartyRef: partyRef,
      displayName: 'Before',
      partyType: 'ORGANIZATION',
      storedPartyRef: partyRef,
    },
  }),
  identifiers: { status: 'ready', value: { items: [] } },
  identity: {
    status: 'ready',
    value: {
      currentFactAssertions: [],
      party,
      resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
    },
  },
  now: DateTime.makeUnsafe(instant),
};

const context = { legalEntityId: '60000000-0000-4000-8000-000000000001', principalId: 'principal-1', tenantId };
const unavailableIdentity = Schema.decodeSync(PartyDetailForbiddenProblemSchema)({
  _tag: 'PartyDetailForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});
const denied = Schema.decodeSync(CounterpartyReadForbiddenProblemSchema)({
  _tag: 'CounterpartyReadForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});

const identityResponse: PartyDetailResponse = {
  currentFactAssertions: [],
  party,
  resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
};
const counterpartyReads: { correlation: string | undefined; payload: CounterpartyReadRequest }[] = [];
const identityReads: PartyDetailRequest[] = [];
const contactReads: PartyContactPointsRequest[] = [];
const identifierReads: PartyOfficialIdentifierHistoryRequest[] = [];
const listReads: CustomerListRequest[] = [];
const writes: { readonly expectedRevision: number }[] = [];
let counterpartyAnswer: Effect.Effect<CounterpartyReadResponse, typeof denied>;
let identityAnswer: Effect.Effect<PartyDetailResponse, typeof unavailableIdentity>;
let listAnswer: Effect.Effect<CustomerListResponse, typeof CustomerListForbiddenProblemSchema.Type>;
const CounterpartyApi = CounterpartyReadApi.prefix('/party-registry-api');
const IdentityApi = PartyDetailApi.prefix('/party-registry-api');
const ContactsApi = PartyContactPointsApi.prefix('/party-registry-api');
const IdentifiersApi = PartyOfficialIdentifierHistoryApi.prefix('/party-registry-api');
const ListApi = CustomerListApi.prefix('/party-registry-api');
const CommandsApi = HttpApi.make('CustomerDetailTestCommands')
  .add(
    HttpApiGroup.make('partyCommands')
      .add(partyRegistryCommandsApi.groups.partyCommands.endpoints.updateParty)
      .middleware(PartyCommandSchemaErrorMiddleware),
  )
  .prefix('/party-registry-api');
// These cases assert cancellation at the HTTP handler: the streaming double carries the request abort to it.
const network = streamingBrowserNetwork(
  shellGatewayIssuer({
    'party-registry': '/party-registry-api',
  }).application,
  serveApi(
    CounterpartyApi,
    HttpApiBuilder.group(CounterpartyApi, 'counterpartyRead', (group) =>
      group.handle('execute', ({ payload, request }) =>
        Effect.suspend(() => {
          counterpartyReads.push({ correlation: request.headers['x-correlation-id'], payload });
          return counterpartyAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    IdentityApi,
    HttpApiBuilder.group(IdentityApi, 'partyDetail', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          identityReads.push(payload);
          return identityAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    ContactsApi,
    HttpApiBuilder.group(ContactsApi, 'partyContactPoints', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          contactReads.push(payload);
          return { items: [] };
        }),
      ),
    ),
  ),
  serveApi(
    IdentifiersApi,
    HttpApiBuilder.group(IdentifiersApi, 'partyOfficialIdentifierHistory', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          identifierReads.push(payload);
          return { items: [] };
        }),
      ),
    ),
  ),
  serveApi(
    ListApi,
    HttpApiBuilder.group(ListApi, 'customerList', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          listReads.push(payload);
          return listAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    CommandsApi,
    HttpApiBuilder.group(CommandsApi, 'partyCommands', (group) =>
      group.handle('updateParty', ({ payload }) =>
        Effect.sync(() => {
          writes.push(payload);
          return { ...party, revision: 2 };
        }),
      ),
    ).pipe(Layer.provide(partyCommandSchemaErrorLive)),
  ),
);

const clearReads = () => {
  counterpartyReads.length = 0;
  identityReads.length = 0;
  contactReads.length = 0;
  identifierReads.length = 0;
};
beforeEach(() => {
  customerDetailData.invalidate();
  customersData.invalidate();
  clearReads();
  listReads.length = 0;
  writes.length = 0;
  listAnswer = Effect.succeed({ items: [customer] });
  counterpartyAnswer = Effect.succeed(snapshot.counterparty);
  identityAnswer = Effect.succeed(identityResponse);
});
afterEach(cleanup);

const expectNoReads = () => {
  expect(counterpartyReads).toHaveLength(0);
  expect(identityReads).toHaveLength(0);
  expect(contactReads).toHaveLength(0);
  expect(identifierReads).toHaveLength(0);
};

it.layer(network, { excludeTestServices: true })('customer detail preload', (suite) => {
  suite.effect('exact direct detail lookup does not consult the bounded customer list or invent a revision', () =>
    Effect.gen(function* directDetail() {
      yield* pinTestDocument;
      listAnswer = Effect.succeed({ items: [] });
      const detail = yield* loadCustomerDetailByRef(counterpartyRef);
      expect(counterpartyReads).toEqual([{ correlation: expect.any(String), payload: { counterpartyRef } }]);
      expect(listReads).toHaveLength(0);
      expect(detail.counterparty.counterpartyRef).toEqual(counterpartyRef);
      expect(detail.identity).toEqual(snapshot.identity);
      if (detail.identity.status === 'ready') {
        expect(detail.identity.value.party.revision).toBe(1);
      }
    }),
  );

  suite.effect('a forbidden list refresh removes the last rows rather than retaining lastReady', () =>
    Effect.gen(function* deniedRefresh() {
      yield* pinTestDocument;
      const query = customersQuery(context);
      yield* customersData.read(query);
      expect(customersData.snapshot(query).state).toBe('ready');
      const failure = yield* Schema.decodeEffect(CustomerListForbiddenProblemSchema)({
        _tag: 'CustomerListForbiddenProblem',
        detail: 'Denied',
        status: 403,
        title: 'Forbidden',
        type: 'urn:test:denied',
      });
      listAnswer = Effect.fail(failure);
      yield* customersData.refresh(query);
      const deniedSnapshot = customersData.snapshot(query);
      expect(deniedSnapshot.state).toBe('failed');
      expect(deniedSnapshot).not.toHaveProperty('value');
    }),
  );

  it('customer list cache keys use the same complete identity as detail prefetch', () => {
    const key = customersData.key(customersQuery(context));
    for (const field of ['legalEntityId', 'principalId', 'tenantId'] as const) {
      expect(customersData.key(customersQuery({ ...context, [field]: 'other' }))).not.toBe(key);
    }
    expect(customersData.key(customersQuery())).not.toBe(key);
  });

  suite.effect('a confirmed identity write preserves the expected revision and invalidates cached sections', () =>
    Effect.gen(function* writeInvalidation() {
      yield* pinTestDocument;
      yield* preloadCustomerDetails(context, [customer]);
      yield* saveCustomerFact(partyRef, { kind: 'name', party, value: 'After' }, 'Correction', 'Source');
      expect(writes[0]?.expectedRevision).toBe(1);
      counterpartyReads.length = 0;
      yield* preloadCustomerDetails(context, [customer]);
      expect(counterpartyReads).toHaveLength(1);
    }),
  );

  suite.effect('a write does not rewarm the visible page; pointing at a row warms that row again', () =>
    Effect.gen(function* rewarmOnIntent() {
      yield* pinTestDocument;
      const rows = [customer, { ...customer, partyRevision: 2 }];
      const scope = pageDataScopeKey(context, 'party.registry') ?? '';
      const { unmount } = renderHook(() => usePrefetchCustomerDetails(context, rows));
      yield* waitUntil(() => counterpartyReads.length === 2);
      expect(counterpartyReads).toHaveLength(2);
      clearReads();
      act(() => customerDetailData.invalidate());
      // A rewarm the write started has reached the owner by the time the network is idle.
      yield* networkIdle;
      // The batch was warmed once; a write that leaves its rows and revisions alone does not warm it again.
      expect(counterpartyReads).toHaveLength(0);
      const row = document.createElement('tr');
      row.dataset['index'] = '1';
      customerDetailIntent(context, () => rows).onPointerEnter({ currentTarget: row });
      yield* waitUntil(() => customerDetailData.snapshot({ customer: rows[1] ?? customer, scope }).state === 'ready');
      expect(counterpartyReads).toHaveLength(1);
      expect(customerDetailData.snapshot({ customer: rows[1] ?? customer, scope }).state).toBe('ready');
      unmount();
    }),
  );

  suite.effect('opens a preloaded customer with all real sections immediately and no detail request', () =>
    Effect.gen(function* customerPreloadTest() {
      yield* pinTestDocument;
      yield* preloadCustomerDetails(context, [customer]);
      clearReads();
      const { result } = renderHook(() => useCustomerDetailSelection(context));
      act(() => result.current.openDetail(customer));
      expect(result.current.detail).toBe(customer);
      expect(result.current.detailValue?.counterparty).toEqual(snapshot.counterparty);
      expect(result.current.detailValue?.identity).toEqual(snapshot.identity);
      expect(result.current.detailValue?.contacts).toEqual(snapshot.contacts);
      expect(result.current.detailValue?.identifiers).toEqual(snapshot.identifiers);
      expect(result.current.detailFailure).toBeUndefined();
      expectNoReads();
    }),
  );

  suite.effect('does not reuse another tenant, company, principal or row revision', () =>
    Effect.gen(function* customerPreloadTest() {
      yield* pinTestDocument;
      yield* preloadCustomerDetails(context, [customer]);
      for (const field of ['tenantId', 'legalEntityId', 'principalId'] as const) {
        clearReads();
        const { result, unmount } = renderHook(() => useCustomerDetailSelection({ ...context, [field]: 'other' }));
        act(() => result.current.openDetail(customer));
        yield* Effect.promise(() => waitFor(() => expect(result.current.detailValue).toBeDefined()));
        expect(counterpartyReads).toHaveLength(1);
        unmount();
      }
      clearReads();
      const { result } = renderHook(() => useCustomerDetailSelection(context));
      act(() => result.current.openDetail({ ...customer, partyRevision: 2 }));
      yield* Effect.promise(() => waitFor(() => expect(result.current.detailValue).toBeDefined()));
      expect(counterpartyReads).toHaveLength(1);
    }),
  );

  suite.effect('scope switching hides the prior selection before effects run and cancels unfinished reads', () =>
    Effect.gen(function* customerPreloadTest() {
      yield* pinTestDocument;
      const started = Deferred.makeUnsafe<true>();
      const interrupted = Deferred.makeUnsafe<true>();
      counterpartyAnswer = Deferred.succeed(started, true).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(interrupted, true)),
      );
      const { rerender, result } = renderHook(({ scope }) => useCustomerDetailSelection(scope), {
        initialProps: { scope: context },
      });
      act(() => result.current.openDetail(customer));
      yield* Deferred.await(started);
      rerender({ scope: { ...context, legalEntityId: 'other-company' } });
      expect(result.current.detail).toBeNull();
      expect(result.current.detailValue).toBeUndefined();
      yield* Deferred.await(interrupted);
    }),
  );

  suite.effect('rapid selection interrupts obsolete work and cannot replace the latest customer', () =>
    Effect.gen(function* customerPreloadTest() {
      yield* pinTestDocument;
      const started = Deferred.makeUnsafe<true>();
      const interrupted = Deferred.makeUnsafe<true>();
      counterpartyAnswer = Deferred.succeed(started, true).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(interrupted, true)),
      );
      const resourceId = yield* Schema.decodeEffect(CustomerListItemSchema.fields.counterpartyId)(
        '30000000-0000-4000-8000-000000000002',
      );
      const other = {
        ...customer,
        counterpartyId: '30000000-0000-4000-8000-000000000002',
        counterpartyRef: {
          ...customer.counterpartyRef,
          resourceId,
        },
      };
      const { result } = renderHook(() => useCustomerDetailSelection(context));
      act(() => result.current.openDetail(customer));
      yield* Deferred.await(started);
      counterpartyAnswer = Effect.succeed(snapshot.counterparty);
      act(() => result.current.openDetail(other));
      yield* Effect.promise(() => waitFor(() => expect(result.current.detailValue).toBeDefined()));
      yield* Deferred.await(interrupted);
      expect(result.current.detail).toBe(other);
    }),
  );

  suite.effect('a denied commercial context renders no fixture and retries after authorization changes', () =>
    Effect.gen(function* customerPreloadTest() {
      yield* pinTestDocument;
      counterpartyAnswer = Effect.fail(denied);
      yield* preloadCustomerDetails(context, [customer]);
      const { result } = renderHook(() => useCustomerDetailSelection(context));
      act(() => result.current.openDetail(customer));
      yield* Effect.promise(() => waitFor(() => expect(result.current.detailFailure).toBe('forbidden')));
      expect(result.current.detailValue).toBeUndefined();
      expect(identityReads).toHaveLength(0);
      counterpartyAnswer = Effect.succeed(snapshot.counterparty);
      act(() => result.current.retryDetail());
      yield* Effect.promise(() => waitFor(() => expect(result.current.detailValue).toBeDefined()));
      expect(result.current.detailFailure).toBeUndefined();
    }),
  );

  suite.effect('a partially forbidden identity never becomes a reusable negative decision', () =>
    Effect.gen(function* customerPreloadTest() {
      yield* pinTestDocument;
      identityAnswer = Effect.fail(unavailableIdentity);
      yield* preloadCustomerDetails(context, [customer]);
      const { result } = renderHook(() => useCustomerDetailSelection(context));
      act(() => result.current.openDetail(customer));
      yield* Effect.promise(() => waitFor(() => expect(result.current.detailValue?.identity.status).toBe('forbidden')));
      expect(identityReads).toHaveLength(2);
      if (snapshot.identity.status === 'ready') {
        identityAnswer = Effect.succeed(snapshot.identity.value);
      }
      act(() => result.current.closeDetail(false));
      act(() => result.current.openDetail(customer));
      yield* Effect.promise(() => waitFor(() => expect(result.current.detailValue?.identity.status).toBe('ready')));
      expect(identityReads).toHaveLength(3);
    }),
  );

  suite.effect('a live authorization change replaces ready data with an explicit denial, not the stale snapshot', () =>
    Effect.gen(function* customerPreloadTest() {
      yield* pinTestDocument;
      yield* preloadCustomerDetails(context, [customer]);
      const { result } = renderHook(() => useCustomerDetailSelection(context));
      act(() => result.current.openDetail(customer));
      expect(result.current.detailValue).toBeDefined();
      counterpartyAnswer = Effect.fail(denied);
      act(() => {
        window.dispatchEvent(new Event(moduleChangeEvent));
      });
      yield* Effect.promise(() => waitFor(() => expect(result.current.detailFailure).toBe('forbidden')));
      expect(result.current.detailValue).toBeUndefined();
    }),
  );

  suite.effect('a visible-page prefetch is bounded and releases unfinished work on page change or unmount', () =>
    Effect.gen(function* customerPreloadTest() {
      yield* pinTestDocument;
      const started = Deferred.makeUnsafe<true>();
      let active = 0;
      let peak = 0;
      counterpartyAnswer = Effect.sync(() => {
        active += 1;
        peak = Math.max(peak, active);
      }).pipe(
        Effect.andThen(Deferred.succeed(started, true)),
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            active -= 1;
          }),
        ),
      );
      const rows = Array.from({ length: 5 }, (_, index) => ({ ...customer, partyRevision: index + 1 }));
      const { rerender, unmount } = renderHook(({ page }) => usePrefetchCustomerDetails(context, page), {
        initialProps: { page: rows },
      });
      yield* Deferred.await(started);
      yield* waitUntil(() => active === 2);
      expect(active).toBe(2);
      expect(peak).toBe(2);
      rerender({ page: [] });
      yield* waitUntil(() => active === 0);
      expect(active).toBe(0);
      expect(counterpartyReads).toHaveLength(2);
      rerender({ page: rows });
      yield* waitUntil(() => active === 2);
      expect(active).toBe(2);
      unmount();
      yield* waitUntil(() => active === 0);
      expect(active).toBe(0);
      expect(counterpartyReads).toHaveLength(4);
    }),
  );

  suite.effect('foreground detail starts without waiting for unrelated background rows', () =>
    Effect.gen(function* customerPreloadTest() {
      yield* pinTestDocument;
      const started = Deferred.makeUnsafe<true>();
      counterpartyAnswer = Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never));
      const rows = [customer, { ...customer, partyRevision: 2 }];
      const background = renderHook(() => usePrefetchCustomerDetails(context, rows));
      yield* Deferred.await(started);
      yield* waitUntil(() => counterpartyReads.length === 2);
      expect(counterpartyReads).toHaveLength(2);
      const foreground = renderHook(() => useCustomerDetailSelection(context));
      act(() => foreground.result.current.openDetail({ ...customer, partyRevision: 3 }));
      yield* waitUntil(() => counterpartyReads.length === 3);
      expect(counterpartyReads).toHaveLength(3);
      foreground.unmount();
      background.unmount();
    }),
  );

  suite.effect('missing context disables shared reuse and preserves direct full-page detail loading', () =>
    Effect.gen(function* customerPreloadTest() {
      yield* pinTestDocument;
      yield* preloadCustomerDetails(undefined, [customer]);
      expectNoReads();
      const values: CustomerDetailSnapshot[] = [];
      loadCustomerDetailInto(customer, (loaded) => {
        if (loaded.value !== undefined) {
          values.push(loaded.value);
        }
      });
      yield* Effect.promise(() => waitFor(() => expect(values).toHaveLength(1)));
      loadCustomerDetailInto(customer, (loaded) => {
        if (loaded.value !== undefined) {
          values.push(loaded.value);
        }
      });
      yield* Effect.promise(() => waitFor(() => expect(values).toHaveLength(2)));
      expect(counterpartyReads).toHaveLength(2);
    }),
  );

  suite.effect('a background reload of the open customer keeps its record in the side panel', () =>
    Effect.gen(function* backgroundReload() {
      yield* pinTestDocument;
      yield* preloadCustomerDetails(context, [customer]);
      const { result } = renderHook(() => useCustomerDetailSelection(context));
      act(() => result.current.openDetail(customer));
      const shown = result.current.detailValue;
      expect(shown).toBeDefined();
      // A live change reloads the same customer; the strict store reads as pending until it answers.
      counterpartyAnswer = Effect.never;
      act(() => {
        window.dispatchEvent(new Event(moduleChangeEvent));
      });
      // The reload has reached the owner, which holds it open.
      yield* networkQuietExcept(1);
      expect(result.current.detailValue).toBe(shown);
      expect(result.current.detailFailure).toBeUndefined();
    }),
  );
});
