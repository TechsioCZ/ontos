// @rstest-environment happy-dom
// How many owner reads opening the customers list sends for its rows' details: the real warm-up hook and the real
// strict detail store, with real clients and owner contracts served in process. Each detail is four owner reads, so
// warming every row of a 30-row page sent 120 reads; the list warms its first rows and leaves the rest to intent.
import { INTENT_READ_CONCURRENCY, LIST_WARM_ROWS } from '@app/admin-ui';
import '@app/admin-ui/testing/module-ui';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Deferred, Effect, Exit, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import type { CounterpartyRef } from '../../shared/resources/counterparty.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { CounterpartyReadApi, CounterpartyReadResponseSchema } from '../../shared/apis/counterparty-read.ts';
import type { CounterpartyReadRequest } from '../../shared/apis/counterparty-read.ts';
import { PartyDetailApi, PartyDetailResponseSchema } from '../../shared/apis/party-detail.ts';
import { PartyContactPointsApi } from '../../shared/apis/party-contact-points.ts';
import { PartyOfficialIdentifierHistoryApi } from '../../shared/apis/party-official-identifier-history.ts';
import { CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import {
  customerDetailData,
  prefetchCustomerDetail,
  usePrefetchCustomerDetails,
} from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';

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

/** Completed once this many Counterparty reads have reached the owner. */
let startedSignal: { readonly count: number; readonly started: Deferred.Deferred<boolean> } | null = null;

const ownerReads: string[] = [];
const counterpartyReads: CounterpartyReadRequest[] = [];
const reads = () => ownerReads.length;
const detailsStarted = () => counterpartyReads.length;

const CounterpartyApi = CounterpartyReadApi.prefix('/party-registry-api');
const DetailApi = PartyDetailApi.prefix('/party-registry-api');
const ContactsApi = PartyContactPointsApi.prefix('/party-registry-api');
const IdentifiersApi = PartyOfficialIdentifierHistoryApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'party-registry': '/party-registry-api' }).application,
  serveApi(
    CounterpartyApi,
    HttpApiBuilder.group(CounterpartyApi, 'counterpartyRead', (group) =>
      group.handle('execute', ({ payload }) => {
        counterpartyReads.push(payload);
        if (startedSignal !== null && counterpartyReads.length === startedSignal.count) {
          Deferred.doneUnsafe(startedSignal.started, Exit.succeed(true));
        }
        ownerReads.push('counterparty');
        return answer(
          Schema.decodeUnknownSync(CounterpartyReadResponseSchema)({
            counterpartyRef: payload.counterpartyRef,
            createdAt: '2026-11-10T10:00:00.000Z',
            currentRoles: [],
            legalEntityRef: {
              moduleId: 'core.identity',
              resourceId: context.legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId,
            },
            party: {
              archived: false,
              canonicalPartyRef: partyRefOf(0),
              displayName: null,
              partyType: 'ORGANIZATION',
              storedPartyRef: partyRefOf(0),
            },
          }),
        );
      }),
    ),
  ),
  serveApi(
    DetailApi,
    HttpApiBuilder.group(DetailApi, 'partyDetail', (group) =>
      group.handle('execute', ({ payload: { partyRef } }) => {
        ownerReads.push('party');
        return answer(
          Schema.decodeUnknownSync(PartyDetailResponseSchema)({
            currentFactAssertions: [],
            party: {
              archivedAt: null,
              businessName: null,
              createdAt: '2026-11-10T10:00:00.000Z',
              displayName: null,
              firstName: null,
              lastName: null,
              partyRef,
              partyType: 'ORGANIZATION',
              revision: 1,
              updatedAt: '2026-11-10T10:00:00.000Z',
            },
            resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
          }),
        );
      }),
    ),
  ),
  serveApi(
    ContactsApi,
    HttpApiBuilder.group(ContactsApi, 'partyContactPoints', (group) =>
      group.handle('execute', () => {
        ownerReads.push('contacts');
        return answer({ items: [] });
      }),
    ),
  ),
  serveApi(
    IdentifiersApi,
    HttpApiBuilder.group(IdentifiersApi, 'partyOfficialIdentifierHistory', (group) =>
      group.handle('execute', () => {
        ownerReads.push('identifiers');
        return answer({ items: [] });
      }),
    ),
  ),
);

/**
 * Lets fake time pass by `millis`, then waits for the network to go idle and React to take what it answered, so
 * every read the passing time started has reached the owner before the test looks.
 */
const pass = (millis: number): Effect.Effect<void> =>
  Effect.promise(() => act(() => rstest.advanceTimersByTimeAsync(millis))).pipe(
    Effect.andThen(networkIdle),
    Effect.andThen(Effect.promise(() => act(() => rstest.advanceTimersByTimeAsync(0)))),
    Effect.asVoid,
  );

/** Lets fake time pass in one-second steps, so every timer and every read it causes runs in between. */
const idle = (seconds: number): Effect.Effect<void> =>
  seconds <= 0 ? pass(0) : pass(1000).pipe(Effect.andThen(Effect.suspend(() => idle(seconds - 1))));

beforeEach(() => {
  // The idle wait and the detail store's freshness window run on the browser runtime's clock: `setTimeout` and `Date`.
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  customerDetailData.invalidate();
  gate = null;
  startedSignal = null;
  ownerReads.length = 0;
  counterpartyReads.length = 0;
});

afterEach(() => {
  cleanup();
  rstest.useRealTimers();
});

it.layer(network, { excludeTestServices: true })('customers list warm requests', (suite) => {
  suite.effect('opening a 30-row customers page warms the details of its first rows only', () =>
    Effect.gen(function* openList() {
      yield* pinTestDocument;
      const { unmount } = renderHook(() => usePrefetchCustomerDetails(context, rows));
      yield* idle(5);
      expect(reads()).toBe(LIST_WARM_ROWS * DETAIL_READS);
      yield* idle(60);
      // The warmed rows are not warmed again when their freshness window passes.
      expect(reads()).toBe(LIST_WARM_ROWS * DETAIL_READS);
      unmount();
    }),
  );

  suite.effect('an opened customers page warms its rows only once the browser is idle', () =>
    Effect.gen(function* warmWhenIdle() {
      yield* pinTestDocument;
      const { unmount } = renderHook(() => usePrefetchCustomerDetails(context, rows));
      // No time has passed: a read the render itself started would have reached the owner by now.
      yield* pass(0);
      expect(reads()).toBe(0);
      // Within a second of an idle browser every warm read has been sent.
      yield* idle(1);
      expect(reads()).toBe(LIST_WARM_ROWS * DETAIL_READS);
      unmount();
    }),
  );

  suite.effect('a customers page left before the browser is idle sends no detail read', () =>
    Effect.gen(function* leaveBeforeIdle() {
      yield* pinTestDocument;
      const { unmount } = renderHook(() => usePrefetchCustomerDetails(context, rows));
      unmount();
      yield* idle(5);
      expect(reads()).toBe(0);
    }),
  );

  suite.effect('pointing at a row further down reads that customer once', () =>
    Effect.gen(function* pointAtColdRow() {
      yield* pinTestDocument;
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

  suite.effect('a fast sweep over many rows reads at most two customers at once and then only the last row', () =>
    Effect.gen(function* fastSweep() {
      yield* pinTestDocument;
      const release = yield* Deferred.make<boolean>();
      const started = yield* Deferred.make<boolean>();
      gate = release;
      startedSignal = { count: INTENT_READ_CONCURRENCY, started };
      for (const customer of rows.slice(LIST_WARM_ROWS)) {
        prefetchCustomerDetail(context, customer);
      }
      yield* Deferred.await(started);
      expect(detailsStarted()).toBe(INTENT_READ_CONCURRENCY);
      yield* Deferred.succeed(release, true);
      yield* idle(5);
      expect(reads()).toBe((INTENT_READ_CONCURRENCY + 1) * DETAIL_READS);
      // Every detail ever started, in order: the two the limiter admitted while held, then only the last row.
      expect(counterpartyReads.map((input) => input.counterpartyRef)).toEqual([
        counterpartyRefOf(LIST_WARM_ROWS),
        counterpartyRefOf(LIST_WARM_ROWS + 1),
        counterpartyRefOf(ROWS - 1),
      ]);
    }),
  );
});
