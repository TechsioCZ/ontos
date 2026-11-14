import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { DateTime, Deferred, Effect, Option, Schema } from 'effect';
import { constVoid as noop } from 'effect/Function';
import { useSyncExternalStore } from 'react';
import { moduleChangeEvent, pageDataPending, pageDataScopeKey } from '@app/shared-contracts/page-data';
import { CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import {
  CounterpartyReadForbiddenProblemSchema,
  CounterpartyReadResponseSchema,
} from '../../shared/apis/counterparty-read.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import { PartyDetailForbiddenProblemSchema } from '../../shared/apis/party-detail.ts';
import { executeCounterpartyRead } from '../../src/api/counterparty-read-client.ts';
import { executePartyDetail } from '../../src/api/party-detail-client.ts';
import { executePartyContactPoints } from '../../src/api/party-contact-points-client.ts';
import { executePartyOfficialIdentifierHistory } from '../../src/api/party-official-identifier-history-client.ts';
import { executeCustomerList } from '../../src/api/customer-list-client.ts';
import { customerSegmentsFor } from '../../src/api/customer-segments-client.ts';
import {
  cachedCustomerDetailByRef,
  customerDetailData,
  customersData,
  customersQuery,
  preloadCustomerDetails,
  useCustomerDetail,
} from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';
import type { CustomerDetailSnapshot } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';
import {
  customerDetailPageData,
  loadCustomerDetailPageRecord,
} from '../../src/routes/[lang]/prodej/zakaznici/customer-detail-page-data.ts';

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
    currentRoles: [
      {
        endProvenance: null,
        provenance: {
          evidenceReference: 'contract:2026-42',
          method: 'SIGNED_CONTRACT',
          reason: 'Signed customer agreement',
          source: 'contracts.core',
        },
        recordedAt: instant,
        rolePeriodRef: {
          moduleId: 'party.registry',
          resourceId: '50000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.counterparty-role-period',
          tenantId,
        },
        roleType: 'CUSTOMER',
        state: 'ACTIVE',
        validFrom: instant,
        validTo: null,
      },
    ],
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

const denied = Schema.decodeSync(CounterpartyReadForbiddenProblemSchema)({
  _tag: 'CounterpartyReadForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});
const translate = (key: string) => key;
interface CustomerDetailHookProps {
  readonly value?: CustomerDetailSnapshot;
}
const initialProps: CustomerDetailHookProps = { value: snapshot };
const useDetail = ({ value }: CustomerDetailHookProps) =>
  useCustomerDetail(customer, value, noop, noop, noop, translate);
const context = {
  legalEntityId: '60000000-0000-4000-8000-000000000001',
  principalId: 'principal-1',
  tenantId,
};
const pageInput = { context, counterpartyId };
const warmCustomer = Effect.gen(function* warmCustomer() {
  yield* customersData.read(customersQuery(context));
  yield* preloadCustomerDetails(context, [customer]);
});
const clearReadCalls = () => {
  rstest.mocked(executeCounterpartyRead).mockClear();
  rstest.mocked(executePartyDetail).mockClear();
  rstest.mocked(executePartyContactPoints).mockClear();
  rstest.mocked(executePartyOfficialIdentifierHistory).mockClear();
  rstest.mocked(executeCustomerList).mockClear();
};

beforeEach(() => {
  rstest.resetAllMocks();
  customerDetailData.invalidate();
  customersData.invalidate();
  customerDetailPageData.invalidate();
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

it.live('a warmed mounted body follows live cache revalidation without another opening or manual reload', () =>
  Effect.gen(function* liveBodyRevalidation() {
    const scope = pageDataScopeKey(context, 'party.registry') ?? '';
    yield* preloadCustomerDetails(context, [customer]);
    const { result } = renderHook(() => {
      const current = useSyncExternalStore(
        (listener) => customerDetailData.subscribe(listener, { customer, scope }),
        () => customerDetailData.snapshot({ customer, scope }),
        () => pageDataPending,
      );
      return useCustomerDetail(
        customer,
        current.state === 'ready' ? current.value : undefined,
        noop,
        noop,
        noop,
        translate,
      );
    });
    expect(result.current.party?.revision).toBe(1);
    if (snapshot.identity.status === 'ready') {
      rstest.mocked(executePartyDetail).mockReturnValue(
        Effect.succeed({
          ...snapshot.identity.value,
          party: { ...party, displayName: Option.some('After live change'), revision: 2 },
        }),
      );
    }
    act(() => {
      globalThis.dispatchEvent(new Event(moduleChangeEvent));
    });
    yield* Effect.promise(() => waitFor(() => expect(result.current.party?.revision).toBe(2)));
    expect(result.current.party?.displayName).toEqual(Option.some('After live change'));
  }),
);

it.live('the full-page preload reuses a complete scoped warmed detail without any owner read', () =>
  Effect.gen(function* warmedPage() {
    yield* warmCustomer;
    const warmed = cachedCustomerDetailByRef(context, counterpartyRef);
    expect(warmed).toBeDefined();
    clearReadCalls();
    expect(yield* customerDetailPageData.read(pageInput)).toBe(warmed);
    expect(customerDetailPageData.snapshot(pageInput).state).toBe('ready');
    expect(yield* customerDetailPageData.read(pageInput)).toBe(warmed);
    expect(executeCounterpartyRead).not.toHaveBeenCalled();
    expect(executePartyDetail).not.toHaveBeenCalled();
    expect(executePartyContactPoints).not.toHaveBeenCalled();
    expect(executePartyOfficialIdentifierHistory).not.toHaveBeenCalled();
    expect(executeCustomerList).not.toHaveBeenCalled();
  }),
);

it.live('a list row alone never substitutes for the independent detail reads', () =>
  Effect.gen(function* listIsNotDetailAuthority() {
    yield* customersData.read(customersQuery(context));
    clearReadCalls();
    yield* loadCustomerDetailPageRecord(pageInput);
    expect(executeCounterpartyRead).toHaveBeenCalledTimes(1);
    expect(executePartyDetail).toHaveBeenCalledTimes(1);
    expect(executePartyContactPoints).toHaveBeenCalledTimes(1);
    expect(executePartyOfficialIdentifierHistory).toHaveBeenCalledTimes(1);
    expect(executeCustomerList).not.toHaveBeenCalled();
  }),
);

it.live('a customer absent from the list cache still opens through the exact Counterparty read', () =>
  Effect.gen(function* coldPageOutsideList() {
    rstest.mocked(executeCustomerList).mockReturnValue(Effect.succeed({ items: [] }));
    yield* customersData.read(customersQuery(context));
    clearReadCalls();
    const record = yield* loadCustomerDetailPageRecord(pageInput);
    expect(record.counterparty).toBe(snapshot.counterparty);
    expect(executeCounterpartyRead).toHaveBeenCalledWith({ counterpartyRef }, expect.any(String));
    expect(executePartyDetail).toHaveBeenCalledTimes(1);
    expect(executeCustomerList).not.toHaveBeenCalled();
  }),
);

it.live('changing principal, tenant or company never reuses the warmed customer facts', () =>
  Effect.gen(function* scopedPageReuse() {
    yield* warmCustomer;
    for (const field of ['principalId', 'tenantId', 'legalEntityId'] as const) {
      const other = { ...context, [field]: 'other-scope' };
      expect(cachedCustomerDetailByRef(other, counterpartyRef)).toBeUndefined();
      clearReadCalls();
      rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.fail(denied));
      const failure = yield* Effect.flip(loadCustomerDetailPageRecord({ ...pageInput, context: other }));
      expect(failure.reason).toBe('forbidden');
      expect(executeCounterpartyRead).toHaveBeenCalledTimes(1);
      expect(executePartyDetail).not.toHaveBeenCalled();
    }
  }),
);

it.live('a live refusal clears both held page data and the warmed detail instead of reusing either', () =>
  Effect.gen(function* invalidatedPage() {
    yield* warmCustomer;
    yield* customerDetailPageData.read(pageInput);
    globalThis.dispatchEvent(new Event(moduleChangeEvent));
    expect(customerDetailPageData.snapshot(pageInput)).toBe(pageDataPending);
    expect(cachedCustomerDetailByRef(context, counterpartyRef)).toBeUndefined();
    clearReadCalls();
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.fail(denied));
    const failure = yield* Effect.flip(customerDetailPageData.read(pageInput));
    expect(failure.reason).toBe('forbidden');
    expect(customerDetailPageData.snapshot(pageInput).state).toBe('failed');
    expect(executeCounterpartyRead).toHaveBeenCalledTimes(1);
    expect(executePartyDetail).not.toHaveBeenCalled();
  }),
);

it.live('a new real list revision cannot reuse the old revision-qualified detail', () =>
  Effect.gen(function* revisedListRow() {
    yield* warmCustomer;
    customersData.update(customersQuery(context), (current) => ({
      ...current,
      items: [{ ...customer, partyRevision: 2 }],
    }));
    expect(cachedCustomerDetailByRef(context, counterpartyRef)).toBeUndefined();
    clearReadCalls();
    yield* loadCustomerDetailPageRecord(pageInput);
    expect(executeCounterpartyRead).toHaveBeenCalledTimes(1);
  }),
);

it.live('a denied required section never supplies a reusable visible-row warm snapshot', () =>
  Effect.gen(function* partialWarmIsNotReady() {
    const failure = yield* Schema.decodeEffect(PartyDetailForbiddenProblemSchema)({
      _tag: 'PartyDetailForbiddenProblem',
      detail: 'Denied',
      status: 403,
      title: 'Forbidden',
      type: 'urn:test:denied',
    });
    rstest.mocked(executePartyDetail).mockReturnValue(Effect.fail(failure));
    yield* warmCustomer;
    expect(cachedCustomerDetailByRef(context, counterpartyRef)).toBeUndefined();
    clearReadCalls();
    const record = yield* loadCustomerDetailPageRecord(pageInput);
    expect(record.identity.status).toBe('forbidden');
    expect(executeCounterpartyRead).toHaveBeenCalledTimes(1);
    expect(executePartyDetail).toHaveBeenCalledTimes(1);
  }),
);

it.live('warmed data must still prove an exact Counterparty, selected company and current CUSTOMER role', () =>
  Effect.gen(function* validateCachedProof() {
    const encoded = yield* Schema.encodeEffect(CounterpartyReadResponseSchema)(snapshot.counterparty);
    const invalid = [
      { ...encoded, currentRoles: [] },
      {
        ...encoded,
        legalEntityRef: { ...encoded.legalEntityRef, resourceId: '60000000-0000-4000-8000-000000000009' },
      },
      {
        ...encoded,
        counterpartyRef: { ...encoded.counterpartyRef, resourceId: '30000000-0000-4000-8000-000000000009' },
      },
    ];
    for (const input of invalid) {
      customersData.invalidate();
      customerDetailData.invalidate();
      const value = yield* Schema.decodeEffect(CounterpartyReadResponseSchema)(input);
      rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.succeed(value));
      yield* warmCustomer;
      clearReadCalls();
      const failure = yield* Effect.flip(loadCustomerDetailPageRecord(pageInput));
      expect(failure.reason).toBe('not-found');
      expect(executeCounterpartyRead).not.toHaveBeenCalled();
    }
  }),
);

it.live('an incomplete Shell scope cannot reuse data or start a cold owner read', () =>
  Effect.gen(function* incompletePageScope() {
    const failure = yield* Effect.flip(
      loadCustomerDetailPageRecord({ ...pageInput, context: { ...context, principalId: '' } }),
    );
    expect(failure.reason).toBe('unavailable');
    expect(executeCounterpartyRead).not.toHaveBeenCalled();
  }),
);

it.live('refreshed owner props replace displayed facts immediately without losing unrelated drafts', () =>
  Effect.sync(() => {
    const { rerender, result } = renderHook(useDetail, { initialProps });
    act(() => result.current.changeDraft('unrelated', 'unsaved'));
    const next: CustomerDetailSnapshot = {
      ...snapshot,
      contacts: { status: 'forbidden' },
      identifiers: { status: 'unavailable' },
      identity: { status: 'forbidden' },
    };
    rerender({ value: next });
    expect(result.current.snapshot).toBe(next);
    expect(result.current.party).toBeUndefined();
    expect(result.current.contactRows.every((row) => row.existing === undefined)).toBe(true);
    expect(result.current.draft).toEqual({ unrelated: 'unsaved' });
    expect(executeCounterpartyRead).not.toHaveBeenCalled();
  }),
);

it.live('a pending parent revalidation cannot leave the old body facts visible', () =>
  Effect.sync(() => {
    const { rerender, result } = renderHook(useDetail, { initialProps });
    rerender({});
    expect(result.current.snapshot).toBeUndefined();
    expect(result.current.party).toBeUndefined();
  }),
);

it.live('a refused local reload clears the displayed owner snapshot', () =>
  Effect.gen(function* refusedReload() {
    const { rerender, result } = renderHook(useDetail, { initialProps });
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.fail(denied));
    act(() => result.current.refresh());
    yield* Effect.promise(() => waitFor(() => expect(result.current.busy).toBe(false)));
    expect(result.current.notice).toBe('party-registry.pages.customers.detail.forbidden');
    expect(result.current.stale).toBe(true);
    expect(result.current.snapshot).toBeUndefined();
    expect(result.current.party).toBeUndefined();
    const revalidated = { ...snapshot };
    rerender({ value: revalidated });
    expect(result.current.snapshot).toBe(revalidated);
    expect(result.current.stale).toBe(false);
  }),
);

it.live('a local Counterparty denial also revokes warmed panel and full-page snapshots', () =>
  Effect.gen(function* refusedReloadRevokesCaches() {
    yield* warmCustomer;
    yield* customerDetailPageData.read(pageInput);
    const { result } = renderHook(useDetail, { initialProps });
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.fail(denied));
    act(() => result.current.refresh());
    yield* Effect.promise(() => waitFor(() => expect(result.current.busy).toBe(false)));
    expect(cachedCustomerDetailByRef(context, counterpartyRef)).toBeUndefined();
    expect(customerDetailPageData.snapshot(pageInput)).toBe(pageDataPending);
    const failure = yield* Effect.flip(customerDetailPageData.read(pageInput));
    expect(failure.reason).toBe('forbidden');
    expect(customerDetailPageData.snapshot(pageInput).state).toBe('failed');
  }),
);

it.live('an independently forbidden Party section cannot reopen from either complete warm cache', () =>
  Effect.gen(function* sectionRefusalRevokesCaches() {
    yield* warmCustomer;
    yield* customerDetailPageData.read(pageInput);
    const { result } = renderHook(useDetail, { initialProps });
    const forbidden = yield* Schema.decodeEffect(PartyDetailForbiddenProblemSchema)({
      _tag: 'PartyDetailForbiddenProblem',
      detail: 'Denied',
      status: 403,
      title: 'Forbidden',
      type: 'urn:test:denied',
    });
    rstest.mocked(executePartyDetail).mockReturnValue(Effect.fail(forbidden));
    act(() => result.current.refresh());
    yield* Effect.promise(() => waitFor(() => expect(result.current.busy).toBe(false)));
    expect(result.current.snapshot?.identity.status).toBe('forbidden');
    expect(cachedCustomerDetailByRef(context, counterpartyRef)).toBeUndefined();
    expect(customerDetailPageData.snapshot(pageInput)).toBe(pageDataPending);
    const reopened = yield* customerDetailPageData.read(pageInput);
    expect(reopened.identity.status).toBe('forbidden');
    expect(reopened.counterparty).toBe(snapshot.counterparty);
  }),
);

it.live('an obsolete in-flight local reload cannot replace a newer owner snapshot', () =>
  Effect.gen(function* obsoleteReload() {
    const gate = yield* Deferred.make<true>();
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Deferred.await(gate).pipe(Effect.as(snapshot.counterparty)));
    const { rerender, result } = renderHook(useDetail, { initialProps });
    act(() => result.current.refresh());
    const next: CustomerDetailSnapshot = { ...snapshot, identity: { status: 'forbidden' } };
    rerender({ value: next });
    yield* Deferred.succeed(gate, true);
    yield* Effect.promise(() => waitFor(() => expect(result.current.busy).toBe(false)));
    expect(result.current.snapshot).toBe(next);
    expect(result.current.party).toBeUndefined();
  }),
);
