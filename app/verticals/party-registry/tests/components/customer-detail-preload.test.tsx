import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { DateTime, Deferred, Effect, Option, Schema } from 'effect';
import { moduleChangeEvent, pageDataScopeKey } from '@app/shared-contracts/page-data';
import { CustomerListForbiddenProblemSchema, CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import {
  CounterpartyReadForbiddenProblemSchema,
  CounterpartyReadResponseSchema,
} from '../../shared/apis/counterparty-read.ts';
import { PartyDetailForbiddenProblemSchema } from '../../shared/apis/party-detail.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import { executeCounterpartyRead } from '../../src/api/counterparty-read-client.ts';
import { executePartyDetail } from '../../src/api/party-detail-client.ts';
import { executePartyContactPoints } from '../../src/api/party-contact-points-client.ts';
import { executePartyOfficialIdentifierHistory } from '../../src/api/party-official-identifier-history-client.ts';
import { executeCustomerList } from '../../src/api/customer-list-client.ts';
import { customerSegmentsFor } from '../../src/api/customer-segments-client.ts';
import { updateParty } from '../../src/api/party-command-client.ts';
import {
  customerDetailData,
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

rstest.mock('../../src/api/party-command-client.ts');
rstest.mock('../../src/api/counterparty-read-client.ts');
rstest.mock('../../src/api/party-detail-client.ts');
rstest.mock('../../src/api/party-contact-points-client.ts');
rstest.mock('../../src/api/party-official-identifier-history-client.ts');
rstest.mock('../../src/api/customer-list-client.ts');
rstest.mock('../../src/api/customer-segments-client.ts');

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
  createdAt: instant,
  displayName: 'Before',
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
      factHistory: Option.none(),
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

beforeEach(() => {
  rstest.resetAllMocks();
  customerDetailData.invalidate();
  customersData.invalidate();
  rstest.mocked(executeCustomerList).mockReturnValue(Effect.succeed({ items: [customer] }));
  rstest.mocked(customerSegmentsFor).mockReturnValue(Effect.succeed(new Map()));
  rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.succeed(snapshot.counterparty));
  if (snapshot.identity.status === 'ready') {
    rstest.mocked(executePartyDetail).mockReturnValue(Effect.succeed(snapshot.identity.value));
  }
  rstest.mocked(executePartyContactPoints).mockReturnValue(Effect.succeed({ items: [] }));
  rstest.mocked(executePartyOfficialIdentifierHistory).mockReturnValue(Effect.succeed({ items: [] }));
});
afterEach(cleanup);

it.live('exact direct detail lookup does not consult the bounded customer list or invent a revision', () =>
  Effect.gen(function* directDetail() {
    rstest.mocked(executeCustomerList).mockReturnValue(Effect.succeed({ items: [] }));
    const detail = yield* loadCustomerDetailByRef(counterpartyRef);
    expect(executeCounterpartyRead).toHaveBeenCalledWith({ counterpartyRef }, expect.any(String));
    expect(executeCustomerList).not.toHaveBeenCalled();
    expect(detail.counterparty.counterpartyRef).toEqual(counterpartyRef);
    expect(detail.identity).toEqual(snapshot.identity);
    if (detail.identity.status === 'ready') {
      expect(detail.identity.value.party.revision).toBe(1);
    }
  }),
);

it.live('a forbidden list refresh removes the last rows rather than retaining lastReady', () =>
  Effect.gen(function* deniedRefresh() {
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
    rstest.mocked(executeCustomerList).mockReturnValue(Effect.fail(failure));
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

it.live('a confirmed identity write preserves the expected revision and invalidates cached sections', () =>
  Effect.gen(function* writeInvalidation() {
    yield* preloadCustomerDetails(context, [customer]);
    rstest.mocked(updateParty).mockReturnValue(Effect.succeed({ ...party, revision: 2 }));
    yield* saveCustomerFact(partyRef, { kind: 'name', party, value: 'After' }, 'Correction', 'Source');
    expect(rstest.mocked(updateParty).mock.calls[0]?.[0].expectedRevision).toBe(1);
    rstest.mocked(executeCounterpartyRead).mockClear();
    yield* preloadCustomerDetails(context, [customer]);
    expect(executeCounterpartyRead).toHaveBeenCalledTimes(1);
  }),
);

const clearCalls = () => {
  rstest.mocked(executeCounterpartyRead).mockClear();
  rstest.mocked(executePartyDetail).mockClear();
  rstest.mocked(executePartyContactPoints).mockClear();
  rstest.mocked(executePartyOfficialIdentifierHistory).mockClear();
};
const expectNoReads = () => {
  expect(executeCounterpartyRead).not.toHaveBeenCalled();
  expect(executePartyDetail).not.toHaveBeenCalled();
  expect(executePartyContactPoints).not.toHaveBeenCalled();
  expect(executePartyOfficialIdentifierHistory).not.toHaveBeenCalled();
};

it.live('a write rewarms every current visible detail even when row ids and list revisions stay the same', () =>
  Effect.gen(function* rewarmVisiblePage() {
    const rows = [customer, { ...customer, partyRevision: 2 }];
    const scope = pageDataScopeKey(context, 'party.registry') ?? '';
    yield* preloadCustomerDetails(context, rows);
    const { unmount } = renderHook(() => usePrefetchCustomerDetails(context, rows));
    clearCalls();
    act(() => customerDetailData.invalidate());
    yield* Effect.promise(() =>
      waitFor(() => {
        expect(executeCounterpartyRead).toHaveBeenCalledTimes(2);
        expect(rows.every((row) => customerDetailData.snapshot({ customer: row, scope }).state === 'ready')).toBe(true);
      }),
    );
    unmount();
  }),
);

it.live('opens a preloaded customer with all real sections immediately and no detail request', () =>
  Effect.gen(function* customerPreloadTest() {
    yield* preloadCustomerDetails(context, [customer]);
    clearCalls();
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

it.live('does not reuse another tenant, company, principal or row revision', () =>
  Effect.gen(function* customerPreloadTest() {
    yield* preloadCustomerDetails(context, [customer]);
    for (const field of ['tenantId', 'legalEntityId', 'principalId'] as const) {
      clearCalls();
      const { result, unmount } = renderHook(() => useCustomerDetailSelection({ ...context, [field]: 'other' }));
      act(() => result.current.openDetail(customer));
      yield* Effect.promise(() => waitFor(() => expect(result.current.detailValue).toBeDefined()));
      expect(executeCounterpartyRead).toHaveBeenCalledTimes(1);
      unmount();
    }
    clearCalls();
    const { result } = renderHook(() => useCustomerDetailSelection(context));
    act(() => result.current.openDetail({ ...customer, partyRevision: 2 }));
    yield* Effect.promise(() => waitFor(() => expect(result.current.detailValue).toBeDefined()));
    expect(executeCounterpartyRead).toHaveBeenCalledTimes(1);
  }),
);

it.live('scope switching hides the prior selection before effects run and cancels unfinished reads', () =>
  Effect.gen(function* customerPreloadTest() {
    const started = Deferred.makeUnsafe<true>();
    const interrupted = Deferred.makeUnsafe<true>();
    rstest
      .mocked(executeCounterpartyRead)
      .mockReturnValue(
        Deferred.succeed(started, true).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(interrupted, true)),
        ),
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

it.live('rapid selection interrupts obsolete work and cannot replace the latest customer', () =>
  Effect.gen(function* customerPreloadTest() {
    const started = Deferred.makeUnsafe<true>();
    const interrupted = Deferred.makeUnsafe<true>();
    rstest
      .mocked(executeCounterpartyRead)
      .mockReturnValueOnce(
        Deferred.succeed(started, true).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(interrupted, true)),
        ),
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
    act(() => result.current.openDetail(other));
    yield* Effect.promise(() => waitFor(() => expect(result.current.detailValue).toBeDefined()));
    yield* Deferred.await(interrupted);
    expect(result.current.detail).toBe(other);
  }),
);

it.live('a denied commercial context renders no fixture and retries after authorization changes', () =>
  Effect.gen(function* customerPreloadTest() {
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.fail(denied));
    yield* preloadCustomerDetails(context, [customer]);
    const { result } = renderHook(() => useCustomerDetailSelection(context));
    act(() => result.current.openDetail(customer));
    yield* Effect.promise(() => waitFor(() => expect(result.current.detailFailure).toBe('forbidden')));
    expect(result.current.detailValue).toBeUndefined();
    expect(executePartyDetail).not.toHaveBeenCalled();
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.succeed(snapshot.counterparty));
    act(() => result.current.retryDetail());
    yield* Effect.promise(() => waitFor(() => expect(result.current.detailValue).toBeDefined()));
    expect(result.current.detailFailure).toBeUndefined();
  }),
);

it.live('a partially forbidden identity never becomes a reusable negative decision', () =>
  Effect.gen(function* customerPreloadTest() {
    rstest.mocked(executePartyDetail).mockReturnValue(Effect.fail(unavailableIdentity));
    yield* preloadCustomerDetails(context, [customer]);
    const { result } = renderHook(() => useCustomerDetailSelection(context));
    act(() => result.current.openDetail(customer));
    yield* Effect.promise(() => waitFor(() => expect(result.current.detailValue?.identity.status).toBe('forbidden')));
    expect(executePartyDetail).toHaveBeenCalledTimes(2);
    if (snapshot.identity.status === 'ready') {
      rstest.mocked(executePartyDetail).mockReturnValue(Effect.succeed(snapshot.identity.value));
    }
    act(() => result.current.closeDetail(false));
    act(() => result.current.openDetail(customer));
    yield* Effect.promise(() => waitFor(() => expect(result.current.detailValue?.identity.status).toBe('ready')));
    expect(executePartyDetail).toHaveBeenCalledTimes(3);
  }),
);

it.live('a live authorization change replaces ready data with an explicit denial, not the stale snapshot', () =>
  Effect.gen(function* customerPreloadTest() {
    yield* preloadCustomerDetails(context, [customer]);
    const { result } = renderHook(() => useCustomerDetailSelection(context));
    act(() => result.current.openDetail(customer));
    expect(result.current.detailValue).toBeDefined();
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.fail(denied));
    act(() => {
      globalThis.dispatchEvent(new Event(moduleChangeEvent));
    });
    yield* Effect.promise(() => waitFor(() => expect(result.current.detailFailure).toBe('forbidden')));
    expect(result.current.detailValue).toBeUndefined();
  }),
);

it.live('a visible-page prefetch is bounded and releases unfinished work on page change or unmount', () =>
  Effect.gen(function* customerPreloadTest() {
    const started = Deferred.makeUnsafe<true>();
    let active = 0;
    let peak = 0;
    rstest.mocked(executeCounterpartyRead).mockImplementation(() =>
      Effect.sync(() => {
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
      ),
    );
    const rows = Array.from({ length: 5 }, (_, index) => ({ ...customer, partyRevision: index + 1 }));
    const { rerender, unmount } = renderHook(({ page }) => usePrefetchCustomerDetails(context, page), {
      initialProps: { page: rows },
    });
    yield* Deferred.await(started);
    yield* Effect.promise(() => waitFor(() => expect(active).toBe(2)));
    expect(peak).toBe(2);
    rerender({ page: [] });
    yield* Effect.promise(() => waitFor(() => expect(active).toBe(0)));
    expect(executeCounterpartyRead).toHaveBeenCalledTimes(2);
    rerender({ page: rows });
    yield* Effect.promise(() => waitFor(() => expect(active).toBe(2)));
    unmount();
    yield* Effect.promise(() => waitFor(() => expect(active).toBe(0)));
    expect(executeCounterpartyRead).toHaveBeenCalledTimes(4);
  }),
);

it.live('foreground detail starts without waiting for unrelated background rows', () =>
  Effect.gen(function* customerPreloadTest() {
    const started = Deferred.makeUnsafe<true>();
    rstest
      .mocked(executeCounterpartyRead)
      .mockReturnValue(Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never)));
    const rows = [customer, { ...customer, partyRevision: 2 }];
    const background = renderHook(() => usePrefetchCustomerDetails(context, rows));
    yield* Deferred.await(started);
    yield* Effect.promise(() => waitFor(() => expect(executeCounterpartyRead).toHaveBeenCalledTimes(2)));
    const foreground = renderHook(() => useCustomerDetailSelection(context));
    act(() => foreground.result.current.openDetail({ ...customer, partyRevision: 3 }));
    yield* Effect.promise(() => waitFor(() => expect(executeCounterpartyRead).toHaveBeenCalledTimes(3)));
    foreground.unmount();
    background.unmount();
  }),
);

it.live('missing context disables shared reuse and preserves direct full-page detail loading', () =>
  Effect.gen(function* customerPreloadTest() {
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
    expect(executeCounterpartyRead).toHaveBeenCalledTimes(2);
  }),
);
