// @rstest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { DateTime, Deferred, Effect, Option, Schema } from 'effect';
import { constVoid as noop } from 'effect/Function';
import { useSyncExternalStore } from 'react';
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  networkQuietExcept,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpServerRequest } from '@modern-js/bff-effect/effect-edge';
import { commerceCustomerContextApi } from '@app/commerce-customer-context/api';
import { HttpApi } from 'effect/http-api';
import { moduleText } from '../support/module-ui.ts';
import { moduleChangeEvent, pageDataPending, pageDataScopeKey } from '@app/shared-contracts/page-data';
import { CustomerListApi, CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import {
  CounterpartyReadApi,
  CounterpartyReadForbiddenProblemSchema,
  CounterpartyReadResponseSchema,
} from '../../shared/apis/counterparty-read.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import {
  PartyDetailApi,
  PartyDetailForbiddenProblemSchema,
  PartyDetailResponseSchema,
} from '../../shared/apis/party-detail.ts';
import type { CounterpartyReadRequest, CounterpartyReadResponse } from '../../shared/apis/counterparty-read.ts';
import type { PartyDetailRequest, PartyDetailResponse } from '../../shared/apis/party-detail.ts';
import { PartyContactPointsApi } from '../../shared/apis/party-contact-points.ts';
import type { PartyContactPointsRequest } from '../../shared/apis/party-contact-points.ts';
import { PartyOfficialIdentifierHistoryApi } from '../../shared/apis/party-official-identifier-history.ts';
import type { PartyOfficialIdentifierHistoryRequest } from '../../shared/apis/party-official-identifier-history.ts';
import type { CustomerListRequest } from '../../shared/apis/customer-list.ts';
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
const translate = moduleText('cs');
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
const identityResponse = Schema.decodeUnknownSync(PartyDetailResponseSchema)({
  currentFactAssertions: [],
  party: Schema.encodeSync(PartySchema)(party),
  resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
});
let counterpartyAnswer: Effect.Effect<CounterpartyReadResponse, typeof denied> = Effect.succeed(snapshot.counterparty);
let partyAnswer: Effect.Effect<PartyDetailResponse, typeof PartyDetailForbiddenProblemSchema.Type> =
  Effect.succeed(identityResponse);
let listItems: readonly (typeof customer)[] = [customer];
const counterpartyReads: { readonly correlation: string | undefined; readonly payload: CounterpartyReadRequest }[] = [];
const partyReads: PartyDetailRequest[] = [];
const contactReads: PartyContactPointsRequest[] = [];
const identifierReads: PartyOfficialIdentifierHistoryRequest[] = [];
const listReads: CustomerListRequest[] = [];
const CounterpartyApi = CounterpartyReadApi.prefix('/party-registry-api');
const IdentityApi = PartyDetailApi.prefix('/party-registry-api');
const ContactsApi = PartyContactPointsApi.prefix('/party-registry-api');
const IdentifiersApi = PartyOfficialIdentifierHistoryApi.prefix('/party-registry-api');
const ListApi = CustomerListApi.prefix('/party-registry-api');
const SegmentsApi = HttpApi.make('CustomerSegmentsTestApi')
  .add(commerceCustomerContextApi.groups.counterpartyCustomerGroupMemberships)
  .prefix('/commerce-customer-context-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'commerce-customer-context': '/commerce-customer-context-api',
    'party-registry': '/party-registry-api',
  }).application,
  serveApi(
    CounterpartyApi,
    HttpApiBuilder.group(CounterpartyApi, 'counterpartyRead', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.gen(function* readCounterparty() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          counterpartyReads.push({ correlation: request.headers['x-correlation-id'], payload });
          return yield* counterpartyAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    IdentityApi,
    HttpApiBuilder.group(IdentityApi, 'partyDetail', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          partyReads.push(payload);
          return partyAnswer;
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
        Effect.sync(() => {
          listReads.push(payload);
          return { items: listItems };
        }),
      ),
    ),
  ),
  serveApi(
    SegmentsApi,
    HttpApiBuilder.group(SegmentsApi, 'counterpartyCustomerGroupMemberships', (group) =>
      group.handle('execute', () => Effect.succeed({ effectiveAt: instant, groups: [], items: [] })),
    ),
  ),
);
const clearReadCalls = () => {
  counterpartyReads.length = 0;
  partyReads.length = 0;
  contactReads.length = 0;
  identifierReads.length = 0;
  listReads.length = 0;
};

beforeEach(() => {
  clearReadCalls();
  customerDetailData.invalidate();
  customersData.invalidate();
  customerDetailPageData.invalidate();
  listItems = [customer];
  counterpartyAnswer = Effect.succeed(snapshot.counterparty);
  partyAnswer = Effect.succeed(identityResponse);
});
afterEach(cleanup);

it.layer(network, { excludeTestServices: true })('customer preload revalidation', (suite) => {
  suite.effect('a warmed mounted body follows live cache revalidation without another opening or manual reload', () =>
    Effect.gen(function* liveBodyRevalidation() {
      yield* pinTestDocument;
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
        partyAnswer = Effect.succeed({
          ...snapshot.identity.value,
          party: { ...party, displayName: Option.some('After live change'), revision: 2 },
        });
      }
      act(() => {
        window.dispatchEvent(new Event(moduleChangeEvent));
      });
      yield* waitUntil(() => result.current.party?.revision === 2);
      expect(result.current.party?.revision).toBe(2);
      expect(result.current.party?.displayName).toEqual(Option.some('After live change'));
    }),
  );

  suite.effect('the full-page preload reuses a complete scoped warmed detail without any owner read', () =>
    Effect.gen(function* warmedPage() {
      yield* pinTestDocument;
      yield* warmCustomer;
      const warmed = cachedCustomerDetailByRef(context, counterpartyRef);
      expect(warmed).toBeDefined();
      clearReadCalls();
      expect(yield* customerDetailPageData.read(pageInput)).toBe(warmed);
      expect(customerDetailPageData.snapshot(pageInput).state).toBe('ready');
      expect(yield* customerDetailPageData.read(pageInput)).toBe(warmed);
      yield* networkIdle;
      expect(counterpartyReads).toHaveLength(0);
      expect(partyReads).toHaveLength(0);
      expect(contactReads).toHaveLength(0);
      expect(identifierReads).toHaveLength(0);
      expect(listReads).toHaveLength(0);
    }),
  );

  suite.effect('a list row alone never substitutes for the independent detail reads', () =>
    Effect.gen(function* listIsNotDetailAuthority() {
      yield* pinTestDocument;
      yield* customersData.read(customersQuery(context));
      clearReadCalls();
      yield* loadCustomerDetailPageRecord(pageInput);
      expect(counterpartyReads).toHaveLength(1);
      expect(partyReads).toHaveLength(1);
      expect(contactReads).toHaveLength(1);
      expect(identifierReads).toHaveLength(1);
      expect(listReads).toHaveLength(0);
    }),
  );

  suite.effect('a customer absent from the list cache still opens through the exact Counterparty read', () =>
    Effect.gen(function* coldPageOutsideList() {
      yield* pinTestDocument;
      listItems = [];
      yield* customersData.read(customersQuery(context));
      clearReadCalls();
      const record = yield* loadCustomerDetailPageRecord(pageInput);
      expect(record.counterparty).toEqual(snapshot.counterparty);
      expect(counterpartyReads).toEqual([{ correlation: expect.any(String), payload: { counterpartyRef } }]);
      expect(partyReads).toHaveLength(1);
      expect(listReads).toHaveLength(0);
    }),
  );

  suite.effect('changing principal, tenant or company never reuses the warmed customer facts', () =>
    Effect.gen(function* scopedPageReuse() {
      yield* pinTestDocument;
      yield* warmCustomer;
      for (const field of ['principalId', 'tenantId', 'legalEntityId'] as const) {
        const other = { ...context, [field]: '90000000-0000-4000-8000-000000000009' };
        expect(cachedCustomerDetailByRef(other, counterpartyRef)).toBeUndefined();
        clearReadCalls();
        counterpartyAnswer = Effect.fail(denied);
        const failure = yield* Effect.flip(loadCustomerDetailPageRecord({ ...pageInput, context: other }));
        expect(failure.reason).toBe('forbidden');
        expect(counterpartyReads).toHaveLength(1);
        expect(partyReads).toHaveLength(0);
      }
    }),
  );

  suite.effect('a live refusal clears both held page data and the warmed detail instead of reusing either', () =>
    Effect.gen(function* invalidatedPage() {
      yield* pinTestDocument;
      yield* warmCustomer;
      yield* customerDetailPageData.read(pageInput);
      window.dispatchEvent(new Event(moduleChangeEvent));
      expect(customerDetailPageData.snapshot(pageInput)).toBe(pageDataPending);
      expect(cachedCustomerDetailByRef(context, counterpartyRef)).toBeUndefined();
      clearReadCalls();
      counterpartyAnswer = Effect.fail(denied);
      const failure = yield* Effect.flip(customerDetailPageData.read(pageInput));
      expect(failure.reason).toBe('forbidden');
      expect(customerDetailPageData.snapshot(pageInput).state).toBe('failed');
      expect(counterpartyReads).toHaveLength(1);
      expect(partyReads).toHaveLength(0);
    }),
  );

  suite.effect('a new real list revision cannot reuse the old revision-qualified detail', () =>
    Effect.gen(function* revisedListRow() {
      yield* pinTestDocument;
      yield* warmCustomer;
      customersData.update(customersQuery(context), (current) => ({
        ...current,
        items: [{ ...customer, partyRevision: 2 }],
      }));
      expect(cachedCustomerDetailByRef(context, counterpartyRef)).toBeUndefined();
      clearReadCalls();
      yield* loadCustomerDetailPageRecord(pageInput);
      expect(counterpartyReads).toHaveLength(1);
    }),
  );

  suite.effect('a denied required section never supplies a reusable visible-row warm snapshot', () =>
    Effect.gen(function* partialWarmIsNotReady() {
      yield* pinTestDocument;
      const failure = yield* Schema.decodeEffect(PartyDetailForbiddenProblemSchema)({
        _tag: 'PartyDetailForbiddenProblem',
        detail: 'Denied',
        status: 403,
        title: 'Forbidden',
        type: 'urn:test:denied',
      });
      partyAnswer = Effect.fail(failure);
      yield* warmCustomer;
      expect(cachedCustomerDetailByRef(context, counterpartyRef)).toBeUndefined();
      clearReadCalls();
      const record = yield* loadCustomerDetailPageRecord(pageInput);
      expect(record.identity.status).toBe('forbidden');
      expect(counterpartyReads).toHaveLength(1);
      expect(partyReads).toHaveLength(1);
    }),
  );

  suite.effect('warmed data must still prove an exact Counterparty, selected company and current CUSTOMER role', () =>
    Effect.gen(function* validateCachedProof() {
      yield* pinTestDocument;
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
        counterpartyAnswer = Effect.succeed(value);
        yield* warmCustomer;
        clearReadCalls();
        const failure = yield* Effect.flip(loadCustomerDetailPageRecord(pageInput));
        expect(failure.reason).toBe('not-found');
        yield* networkIdle;
        expect(counterpartyReads).toHaveLength(0);
      }
    }),
  );

  suite.effect('an incomplete Shell scope cannot reuse data or start a cold owner read', () =>
    Effect.gen(function* incompletePageScope() {
      yield* pinTestDocument;
      const failure = yield* Effect.flip(
        loadCustomerDetailPageRecord({ ...pageInput, context: { ...context, principalId: '' } }),
      );
      expect(failure.reason).toBe('unavailable');
      yield* networkIdle;
      expect(counterpartyReads).toHaveLength(0);
    }),
  );

  suite.effect('refreshed owner props replace displayed facts immediately without losing unrelated drafts', () =>
    Effect.gen(function* ownerProps() {
      yield* pinTestDocument;
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
      // A refetch the prop change wrongly started goes through the gateway to the owner; it has arrived by now.
      yield* networkIdle;
      expect(counterpartyReads).toHaveLength(0);
    }),
  );

  suite.effect('a pending parent revalidation cannot leave the old body facts visible', () =>
    Effect.gen(function* ownerProps() {
      yield* pinTestDocument;
      const { rerender, result } = renderHook(useDetail, { initialProps });
      rerender({});
      expect(result.current.snapshot).toBeUndefined();
      expect(result.current.party).toBeUndefined();
    }),
  );

  suite.effect('a refused local reload clears the displayed owner snapshot', () =>
    Effect.gen(function* refusedReload() {
      yield* pinTestDocument;
      const { rerender, result } = renderHook(useDetail, { initialProps });
      counterpartyAnswer = Effect.fail(denied);
      act(() => result.current.refresh());
      yield* waitUntil(() => !result.current.busy);
      expect(result.current.busy).toBe(false);
      expect(result.current.notice).toBe(translate('party-registry.pages.customers.detail.forbidden'));
      expect(result.current.stale).toBe(true);
      yield* networkIdle;
      expect(result.current.snapshot).toBeUndefined();
      expect(result.current.party).toBeUndefined();
      const revalidated = { ...snapshot };
      rerender({ value: revalidated });
      expect(result.current.snapshot).toBe(revalidated);
      expect(result.current.stale).toBe(false);
    }),
  );

  suite.effect('a local Counterparty denial also revokes warmed panel and full-page snapshots', () =>
    Effect.gen(function* refusedReloadRevokesCaches() {
      yield* pinTestDocument;
      yield* warmCustomer;
      yield* customerDetailPageData.read(pageInput);
      const { result } = renderHook(useDetail, { initialProps });
      counterpartyAnswer = Effect.fail(denied);
      act(() => result.current.refresh());
      yield* waitUntil(() => !result.current.busy);
      expect(result.current.busy).toBe(false);
      yield* networkIdle;
      expect(cachedCustomerDetailByRef(context, counterpartyRef)).toBeUndefined();
      expect(customerDetailPageData.snapshot(pageInput)).toBe(pageDataPending);
      const failure = yield* Effect.flip(customerDetailPageData.read(pageInput));
      expect(failure.reason).toBe('forbidden');
      expect(customerDetailPageData.snapshot(pageInput).state).toBe('failed');
    }),
  );

  suite.effect('an independently forbidden Party section cannot reopen from either complete warm cache', () =>
    Effect.gen(function* sectionRefusalRevokesCaches() {
      yield* pinTestDocument;
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
      partyAnswer = Effect.fail(forbidden);
      act(() => result.current.refresh());
      yield* waitUntil(() => !result.current.busy);
      expect(result.current.busy).toBe(false);
      expect(result.current.snapshot?.identity.status).toBe('forbidden');
      yield* networkIdle;
      expect(cachedCustomerDetailByRef(context, counterpartyRef)).toBeUndefined();
      expect(customerDetailPageData.snapshot(pageInput)).toBe(pageDataPending);
      const reopened = yield* customerDetailPageData.read(pageInput);
      expect(reopened.identity.status).toBe('forbidden');
      expect(reopened.counterparty).toEqual(snapshot.counterparty);
    }),
  );

  suite.effect('an obsolete in-flight local reload cannot replace a newer owner snapshot', () =>
    Effect.gen(function* obsoleteReload() {
      yield* pinTestDocument;
      const gate = yield* Deferred.make<true>();
      counterpartyAnswer = Deferred.await(gate).pipe(Effect.as(snapshot.counterparty));
      const { rerender, result } = renderHook(useDetail, { initialProps });
      act(() => result.current.refresh());
      yield* networkQuietExcept(1);
      const next: CustomerDetailSnapshot = { ...snapshot, identity: { status: 'forbidden' } };
      rerender({ value: next });
      yield* Deferred.succeed(gate, true);
      yield* waitUntil(() => !result.current.busy);
      expect(result.current.busy).toBe(false);
      yield* networkIdle;
      expect(result.current.snapshot).toBe(next);
      expect(result.current.party).toBeUndefined();
    }),
  );
});
