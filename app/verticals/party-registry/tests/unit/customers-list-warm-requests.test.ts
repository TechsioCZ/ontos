// @rstest-environment happy-dom
// How many owner reads opening the customers list sends for its rows' details: the real warm-up hook and the real
// strict detail store, with the owner clients replaced and the clock faked. Each detail is four owner reads, so
// warming every row of a 30-row page sent 120 reads; the list warms its first rows and leaves the rest to intent.
import { INTENT_READ_CONCURRENCY, LIST_WARM_ROWS } from '@app/admin-ui';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import type { CounterpartyRef } from '../../shared/resources/counterparty.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { executeCounterpartyRead } from '../../src/api/counterparty-read-client.ts';
import { executePartyContactPoints } from '../../src/api/party-contact-points-client.ts';
import { executePartyDetail } from '../../src/api/party-detail-client.ts';
import { executePartyOfficialIdentifierHistory } from '../../src/api/party-official-identifier-history-client.ts';
import { CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import {
  customerDetailData,
  prefetchCustomerDetail,
  usePrefetchCustomerDetails,
} from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';

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
const ROWS = 30;
/** Owner reads behind one customer detail: Counterparty, party, contact points and identifiers. */
const DETAIL_READS = 4;

const idOf = (prefix: string, index: number) => `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;
const counterpartyRefOf = (index: number): CounterpartyRef => ({
  moduleId: 'party.registry',
  resourceId: idOf('30000000', index),
  resourceType: 'party.registry.counterparty',
  tenantId,
});
const partyRefOf = (index: number): PartyRef => ({
  moduleId: 'party.registry',
  resourceId: idOf('40000000', index),
  resourceType: 'party.registry.party',
  tenantId,
});
const rows = Array.from({ length: ROWS }, (_, index) =>
  Schema.decodeUnknownSync(CustomerListItemSchema)({
    city: null,
    companyId: null,
    counterpartyId: counterpartyRefOf(index).resourceId,
    counterpartyRef: counterpartyRefOf(index),
    createdAt: '2026-11-10T10:00:00.000Z',
    displayName: null,
    email: null,
    partyId: partyRefOf(index).resourceId,
    partyRef: partyRefOf(index),
    partyRevision: 1,
    phone: null,
    status: 'ACTIVE',
    vatId: null,
  }),
);

/** While set, owner reads wait for it to be released; unset, they answer in the same tick. */
let gate: Deferred.Deferred<boolean> | null = null;
const answer = <Value>(value: Value) =>
  gate === null ? Effect.succeed(value) : Deferred.await(gate).pipe(Effect.as(value));

const serve = () => {
  // SAFETY: the stub answers the fields the detail load reads: its reference and the canonical party.
  rstest
    .mocked(executeCounterpartyRead)
    .mockImplementation(
      ({ counterpartyRef }) => answer({ counterpartyRef, party: { canonicalPartyRef: partyRefOf(0) } }) as never,
    );
  // SAFETY: the stub answers the one field the load reads, the resolved party reference.
  rstest
    .mocked(executePartyDetail)
    .mockImplementation(({ partyRef }) => answer({ resolution: { canonicalPartyRef: partyRef } }) as never);
  // SAFETY: the sections are rendered by the page, not read by the load.
  rstest.mocked(executePartyContactPoints).mockImplementation(() => answer({ items: [] }) as never);
  // SAFETY: the sections are rendered by the page, not read by the load.
  rstest.mocked(executePartyOfficialIdentifierHistory).mockImplementation(() => answer({ items: [] }) as never);
};

const reads = () =>
  [executeCounterpartyRead, executePartyDetail, executePartyContactPoints, executePartyOfficialIdentifierHistory]
    .map((client) => rstest.mocked(client).mock.calls.length)
    .reduce((sum, calls) => sum + calls, 0);
const detailsStarted = () => rstest.mocked(executeCounterpartyRead).mock.calls.length;

const idle = (seconds: number): Effect.Effect<void> =>
  seconds <= 0
    ? Effect.void
    : Effect.promise(() => act(() => rstest.advanceTimersByTimeAsync(1000))).pipe(
        Effect.andThen(Effect.suspend(() => idle(seconds - 1))),
      );

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  rstest.resetAllMocks();
  customerDetailData.invalidate();
  gate = null;
  serve();
});

afterEach(() => {
  cleanup();
  rstest.useRealTimers();
  rstest.unstubAllGlobals();
});

it.effect('opening a 30-row customers page warms the details of its first rows only', () =>
  Effect.gen(function* openList() {
    const { unmount } = renderHook(() => usePrefetchCustomerDetails(context, rows));
    yield* idle(5);
    expect(reads()).toBe(LIST_WARM_ROWS * DETAIL_READS);
    yield* idle(60);
    // The warmed rows are not warmed again when their freshness window passes.
    expect(reads()).toBe(LIST_WARM_ROWS * DETAIL_READS);
    unmount();
  }),
);

it.effect('an opened customers page warms its rows only once the browser is idle', () =>
  Effect.gen(function* warmWhenIdle() {
    const { unmount } = renderHook(() => usePrefetchCustomerDetails(context, rows));
    yield* idle(0);
    expect(reads()).toBe(0);
    yield* idle(1);
    expect(reads()).toBe(LIST_WARM_ROWS * DETAIL_READS);
    unmount();
  }),
);

it.effect('a customers page left before the browser is idle sends no detail read', () =>
  Effect.gen(function* leaveBeforeIdle() {
    const { unmount } = renderHook(() => usePrefetchCustomerDetails(context, rows));
    unmount();
    yield* idle(5);
    expect(reads()).toBe(0);
  }),
);

it.effect('pointing at a row further down reads that customer once', () =>
  Effect.gen(function* pointAtColdRow() {
    const last = rows.at(-1);
    expect(last).toBeDefined();
    if (last !== undefined) {
      prefetchCustomerDetail(context, last);
      prefetchCustomerDetail(context, last);
    }
    yield* idle(1);
    expect(reads()).toBe(DETAIL_READS);
  }),
);

it.effect('a fast sweep over many rows reads at most two customers at once and then only the last row', () =>
  Effect.gen(function* fastSweep() {
    const release = yield* Deferred.make<boolean>();
    gate = release;
    for (const customer of rows.slice(LIST_WARM_ROWS)) {
      prefetchCustomerDetail(context, customer);
    }
    expect(detailsStarted()).toBe(INTENT_READ_CONCURRENCY);
    yield* Deferred.succeed(release, true);
    yield* idle(5);
    expect(reads()).toBe((INTENT_READ_CONCURRENCY + 1) * DETAIL_READS);
    expect(rstest.mocked(executeCounterpartyRead).mock.calls.map(([input]) => input.counterpartyRef)).toEqual([
      counterpartyRefOf(LIST_WARM_ROWS),
      counterpartyRefOf(LIST_WARM_ROWS + 1),
      counterpartyRefOf(ROWS - 1),
    ]);
  }),
);
