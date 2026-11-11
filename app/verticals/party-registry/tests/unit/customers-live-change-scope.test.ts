// @rstest-environment happy-dom
// What an idle customers list and its visible rows send: the real strict stores and `usePrefetchCustomerDetails`, with
// the owner clients replaced and the clock faked. The list reloads on a live change of the apps it shows and on its
// freshness window; its rows' details are warmed once per batch and read again only on intent. Changes of other apps
// read nothing.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { executeCustomerList } from '../../src/api/customer-list-client.ts';
import { customerSegmentsFor } from '../../src/api/customer-segments-client.ts';
import { executeCounterpartyRead } from '../../src/api/counterparty-read-client.ts';
import { executePartyContactPoints } from '../../src/api/party-contact-points-client.ts';
import { executePartyDetail } from '../../src/api/party-detail-client.ts';
import { executePartyOfficialIdentifierHistory } from '../../src/api/party-official-identifier-history-client.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import {
  customerDetailData,
  customerDetailIntent,
  customersData,
  customersQuery,
  usePrefetchCustomerDetails,
} from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';

rstest.mock('../../src/api/customer-list-client.ts');
rstest.mock('../../src/api/customer-segments-client.ts');
rstest.mock('../../src/api/counterparty-read-client.ts');
rstest.mock('../../src/api/party-detail-client.ts');
rstest.mock('../../src/api/party-contact-points-client.ts');
rstest.mock('../../src/api/party-official-identifier-history-client.ts');

const tenantId = '10000000-0000-4000-8000-000000000001';
const context: ModulePageContext = {
  legalEntityId: '60000000-0000-4000-8000-000000000001',
  principalId: 'principal-1',
  tenantId,
};
const partyRef: PartyRef = {
  moduleId: 'party.registry',
  resourceId: '40000000-0000-4000-8000-000000000000',
  resourceType: 'party.registry.party',
  tenantId,
};
const rows = Array.from({ length: 3 }, (_, index) => {
  const suffix = String(index + 1).padStart(12, '0');
  const counterpartyId = `30000000-0000-4000-8000-${suffix}`;
  return Schema.decodeSync(CustomerListItemSchema)({
    city: null,
    companyId: null,
    counterpartyId,
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: counterpartyId,
      resourceType: 'party.registry.counterparty',
      tenantId,
    },
    createdAt: '2026-10-15T10:00:00.000Z',
    displayName: `Customer ${index + 1}`,
    email: null,
    partyId: `40000000-0000-4000-8000-${suffix}`,
    partyRef: { ...partyRef, resourceId: `40000000-0000-4000-8000-${suffix}` },
    partyRevision: 7,
    phone: null,
    status: 'ACTIVE',
    vatId: null,
  });
});

/** Runs of the list load. Its Effect is built once, so the count is taken when the Effect runs. */
let listRuns = 0;
const serve = () => {
  listRuns = 0;
  rstest.mocked(customerSegmentsFor).mockImplementation(() => Effect.succeed(new Map()));
  // SAFETY: the stubs answer only the response fields the store reads; the other fields are never read here.
  rstest.mocked(executeCustomerList).mockImplementation(
    () =>
      Effect.sync(() => {
        listRuns += 1;
        return { items: rows };
      }) as never,
  );
  // SAFETY: the stub answers the one field the detail load reads, the canonical party reference.
  rstest
    .mocked(executeCounterpartyRead)
    .mockImplementation(() => Effect.succeed({ party: { canonicalPartyRef: partyRef } }) as never);
  // SAFETY: the stub answers the one field the detail load reads, the resolved party reference.
  rstest
    .mocked(executePartyDetail)
    .mockImplementation(() => Effect.succeed({ resolution: { canonicalPartyRef: partyRef } }) as never);
  // SAFETY: the stub answers the item list the detail load checks for readiness; its items are not read here.
  rstest.mocked(executePartyContactPoints).mockImplementation(() => Effect.succeed({ items: [] }) as never);
  // SAFETY: the stub answers the item list the detail load checks for readiness; its items are not read here.
  rstest.mocked(executePartyOfficialIdentifierHistory).mockImplementation(() => Effect.succeed({ items: [] }) as never);
};

const listReads = () => listRuns;
/** One counterparty read starts each row's detail load. */
const detailReads = () => rstest.mocked(executeCounterpartyRead).mock.calls.length;

/** A mounted list: its listener reads the snapshot as React does, so the store treats the key as observed. */
const observeList = (query: string) => customersData.subscribe(() => customersData.snapshot(query), query);

/** The Shell's live channel reports a change committed elsewhere in `apps`. */
const liveChange = (apps: readonly string[]) =>
  Effect.sync(() => globalThis.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps } })));

/** Lets fake time pass in one-second steps, so every timer and every render it causes runs in between. */
const idle = (seconds: number): Effect.Effect<void> =>
  seconds <= 0
    ? Effect.void
    : Effect.promise(() => act(() => rstest.advanceTimersByTimeAsync(1000))).pipe(
        Effect.andThen(Effect.suspend(() => idle(seconds - 1))),
      );

const rowElement = (index: number): HTMLElement => {
  const row = document.createElement('tr');
  row.dataset['index'] = String(index);
  return row;
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  rstest.resetAllMocks();
  customersData.invalidate();
  customerDetailData.invalidate();
  serve();
});

afterEach(() => {
  cleanup();
  rstest.useRealTimers();
  rstest.unstubAllGlobals();
});

/** Mounts the list and its visible rows, and lets the rows warm once. */
const mountPage = (query: string) => {
  const unsubscribe = observeList(query);
  // The store's freshness timer belongs to the browser runtime, as on the page, not to the test fiber.
  browserRuntime.runFork(customersData.preload(query));
  const { unmount } = renderHook(() => usePrefetchCustomerDetails(context, rows));
  return () => {
    unmount();
    unsubscribe();
  };
};

it.effect('an idle list reloads on its freshness window and reads no row detail', () =>
  Effect.gen(function* idleList() {
    const unmount = mountPage(customersQuery(context));
    yield* idle(3);
    expect(detailReads()).toBe(rows.length);
    const lists = listReads();

    yield* idle(60);
    expect(listReads()).toBeGreaterThan(lists);
    expect(detailReads()).toBe(rows.length);
    unmount();
  }),
);

it.effect('a live change of party-registry reloads the list and no row detail', () =>
  Effect.gen(function* listOnly() {
    const unmount = mountPage(customersQuery(context));
    yield* idle(3);
    const lists = listReads();
    const details = detailReads();

    yield* liveChange(['party-registry']);
    yield* idle(2);
    expect(listReads()).toBe(lists + 1);
    expect(detailReads()).toBe(details);
    unmount();
  }),
);

it.effect('live changes of apps the list does not show read nothing', () =>
  Effect.gen(function* unrelated() {
    const unmount = mountPage(customersQuery(context));
    yield* idle(3);
    const lists = listReads();
    const details = detailReads();

    for (let event = 0; event < 3; event += 1) {
      yield* liveChange(['merchandise', 'tagging', 'shell']);
      yield* idle(2);
    }
    expect(listReads()).toBe(lists);
    expect(detailReads()).toBe(details);
    unmount();
  }),
);

it.effect('pointing at a row whose detail expired reads that detail once', () =>
  Effect.gen(function* pointedRowReadsOnce() {
    const unmount = mountPage(customersQuery(context));
    yield* idle(3);
    expect(detailReads()).toBe(rows.length);

    // Every warmed detail expires; the batch is not warmed again by that.
    act(() => customerDetailData.invalidate());
    yield* idle(2);
    expect(detailReads()).toBe(rows.length);

    const intent = customerDetailIntent(context, () => rows);
    intent.onPointerEnter({ currentTarget: rowElement(1) });
    yield* idle(2);
    expect(detailReads()).toBe(rows.length + 1);
    // The entry is fresh again: the next intent on the same row answers without a request.
    intent.onFocus({ currentTarget: rowElement(1) });
    yield* idle(2);
    expect(detailReads()).toBe(rows.length + 1);
    unmount();
  }),
);
