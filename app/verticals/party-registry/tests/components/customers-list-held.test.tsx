// @rstest-environment happy-dom
// The real strict store and held hook across reloads, served by the owners' real HTTP contracts.
import { passFakeTime, settle, unmountAll, waitUntil, waitUntilOnFakeTimers } from '@app/admin-ui/testing/module-ui';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { CounterpartyCustomerGroupMembershipsApi } from '../../../commerce-customer-context/shared/apis/counterparty-customer-group-memberships.ts';
import {
  CustomerListApi,
  CustomerListForbiddenProblemSchema,
  CustomerListItemSchema,
} from '../../shared/apis/customer-list.ts';
import type { CustomerListRequest, CustomerListResponse } from '../../shared/apis/customer-list.ts';
import {
  customersData,
  customersQuery,
  useCustomersSnapshot,
} from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const counterpartyId = '30000000-0000-4000-8000-000000000001';
const instant = '2026-10-15T10:00:00.000Z';
const customerOf = (displayName: string) =>
  Schema.decodeSync(CustomerListItemSchema)({
    city: null,
    companyId: null,
    counterpartyId,
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: counterpartyId,
      resourceType: 'party.registry.counterparty',
      tenantId,
    },
    createdAt: instant,
    displayName,
    email: null,
    partyId,
    partyRef: { moduleId: 'party.registry', resourceId: partyId, resourceType: 'party.registry.party', tenantId },
    partyRevision: 1,
    phone: null,
    status: 'ACTIVE',
    vatId: null,
  });
const denied = Schema.decodeSync(CustomerListForbiddenProblemSchema)({
  _tag: 'CustomerListForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});
const company = { legalEntityId: '60000000-0000-4000-8000-000000000001', principalId: 'principal-1', tenantId };
const otherCompany = { ...company, legalEntityId: '60000000-0000-4000-8000-000000000002' };

let answer: Effect.Effect<CustomerListResponse, typeof CustomerListForbiddenProblemSchema.Type>;
const reads: CustomerListRequest[] = [];
const OwnerListApi = CustomerListApi.prefix('/party-registry-api');
const listOwner = HttpApiBuilder.group(OwnerListApi, 'customerList', (group) =>
  group.handle('execute', ({ payload }) =>
    Effect.suspend(() => {
      reads.push(payload);
      return answer;
    }),
  ),
);
const OwnerMembershipsApi = CounterpartyCustomerGroupMembershipsApi.prefix('/commerce-customer-context-api');
const membershipsOwner = HttpApiBuilder.group(OwnerMembershipsApi, 'counterpartyCustomerGroupMemberships', (group) =>
  group.handle('execute', () => Effect.succeed({ effectiveAt: instant, groups: [], items: [] })),
);
const network = browserNetwork(
  shellGatewayIssuer({
    'commerce-customer-context': '/commerce-customer-context-api',
    'party-registry': '/party-registry-api',
  }).application,
  serveApi(OwnerListApi, listOwner),
  serveApi(OwnerMembershipsApi, membershipsOwner),
);

/** What the page makes of the read: the rows it shows, or the state that replaces them. */
const tableOf = (snapshot: ReturnType<typeof useCustomersSnapshot>): string =>
  snapshot.state === 'ready'
    ? `rows:${snapshot.value.items.map((item) => item.displayName ?? '').join(',')}`
    : snapshot.state;

const shown: string[] = [];
const useTable = ({ context }: { readonly context: typeof company }) => {
  const table = tableOf(useCustomersSnapshot(customersQuery(context)));
  shown.push(table);
  return table;
};

/** A live change arrives: every strict store drops what it has and mounted readers read again. */
const liveChange = () => {
  act(() => {
    window.dispatchEvent(new Event(moduleChangeEvent));
  });
};

beforeEach(() => {
  answer = Effect.succeed({ items: [customerOf('Before')] });
  reads.length = 0;
  customersData.invalidate();
  shown.length = 0;
});
afterEach(() => {
  cleanup();
  unmountAll();
  rstest.useRealTimers();
});

it.live('the rows stay on screen while the same register reloads', () =>
  Effect.gen(function* held() {
    yield* pinTestDocument;
    yield* customersData.read(customersQuery(company));
    const { result } = renderHook(useTable, { initialProps: { context: company } });
    expect(result.current).toBe('rows:Before');

    const gate = yield* Deferred.make<boolean>();
    answer = Deferred.await(gate).pipe(Effect.as({ items: [customerOf('After')] }));
    shown.length = 0;
    liveChange();
    expect(customersData.snapshot(customersQuery(company)).state).toBe('pending');
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown)).toEqual(new Set(['rows:Before']));

    yield* Deferred.succeed(gate, true);
    yield* waitUntil(() => result.current === 'rows:After');
    expect(result.current).toBe('rows:After');
    expect(shown.filter((table) => !table.startsWith('rows:'))).toEqual([]);
  }).pipe(Effect.provide(network)),
);

it.live('another company never shows the rows held for the company before it', () =>
  Effect.gen(function* otherScope() {
    yield* pinTestDocument;
    yield* customersData.read(customersQuery(company));
    const { rerender, result } = renderHook(useTable, { initialProps: { context: company } });
    expect(result.current).toBe('rows:Before');

    const gate = yield* Deferred.make<boolean>();
    answer = Deferred.await(gate).pipe(Effect.as({ items: [customerOf('Theirs')] }));
    liveChange();
    shown.length = 0;
    rerender({ context: otherCompany });
    expect(new Set(shown)).toEqual(new Set(['pending']));
    yield* Deferred.succeed(gate, true);
    yield* waitUntil(() => customersData.snapshot(customersQuery(company)).state === 'ready');
    yield* settle;
  }).pipe(Effect.provide(network)),
);

it.live('a refused reload takes the held rows away at once', () =>
  Effect.gen(function* refused() {
    yield* pinTestDocument;
    yield* customersData.read(customersQuery(company));
    const { result } = renderHook(useTable, { initialProps: { context: company } });
    expect(result.current).toBe('rows:Before');

    answer = Effect.fail(denied);
    liveChange();
    yield* waitUntil(() => result.current === 'failed');
    expect(result.current).toBe('failed');
  }).pipe(Effect.provide(network)),
);

it.live('a list reopened after its rows went stale shows them at once and reloads once', () =>
  Effect.gen(function* reopenedList() {
    // The store's freshness window runs on the browser runtime's clock: `setTimeout` and `Date`.
    rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    yield* pinTestDocument;
    yield* customersData.read(customersQuery(company));
    const first = renderHook(useTable, { initialProps: { context: company } });
    expect(first.result.current).toBe('rows:Before');
    first.unmount();

    // Let the real store's 20 s freshness window pass with no mounted reader.
    yield* passFakeTime('30 seconds');
    const loadsBefore = reads.length;
    shown.length = 0;
    const second = renderHook(useTable, { initialProps: { context: company } });
    expect(shown[0]).toBe('rows:Before');
    expect(shown).not.toContain('pending');
    // The page's mount effect starts the one background reload that follows.
    act(() => {
      customersData.ensure(customersQuery(company));
    });
    yield* waitUntilOnFakeTimers(() => customersData.snapshot(customersQuery(company)).state === 'ready');
    yield* passFakeTime('1 second', { between: networkIdle });
    expect(reads.length - loadsBefore).toBe(1);
    expect(second.result.current).toBe('rows:Before');
    second.unmount();
  }).pipe(Effect.provide(network)),
);
