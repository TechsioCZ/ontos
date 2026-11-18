// @rstest-environment happy-dom
// The customer directory the orders page asks for with its first page. The first orders read is held open by the
// test, so what starts before it returns is visible. A remembered "may edit orders" answer starts the directory with
// the page; without one the directory waits for the read, as it always did. The tab's sessionStorage carries the
// answer to the next document.
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import { pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  networkQuietExcept,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  CustomerListApi,
  CustomerListInternalProblemSchema,
} from '../../../party-registry/shared/apis/customer-list.ts';
import type { CustomerListRequest, CustomerListResponse } from '../../../party-registry/shared/apis/customer-list.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { customerDirectoryData } from '../../src/routes/[lang]/prodej/objednavky/customers-directory.ts';
import {
  orderCountsData,
  ordersPageData,
  preloadOrdersPage,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

const PAGE_SIZE = 50;
const TENANT = 'tenant-1';
const COMPANY = 'company-1';
const OTHER_COMPANY = 'company-2';
const FIRST_PERSON = 'principal-first';
const SECOND_PERSON = 'principal-second';
const REMEMBERED_PERSON = 'principal-remembered';
const FRESH_PERSON = 'principal-fresh';
const REVOKED_PERSON = 'principal-revoked';
const EARLIER_DOCUMENT_PERSON = 'principal-earlier-document';
const FAILING_DIRECTORY_PERSON = 'principal-failing-directory';
const REMEMBERED_YES = 'yes';

const contextOf = (principalId: string, legalEntityId = COMPANY): ModulePageContext => ({
  legalEntityId,
  principalId,
  tenantId: TENANT,
});

/** Where the orders page keeps a yes for the next document of the same tab. */
const storageKeyOf = (who: ModulePageContext): string =>
  `merchandise.orders.may-edit:${pageDataScopeKey(who, 'demo.merchandise') ?? ''}`;

const recordsOf = (canEditOrders: boolean) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canEditOrders,
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 0, stockValueMinor: 0 },
    movements: [],
    orders: [],
    products: [],
    revision: 7,
    taxRates: [],
    totalOrders: 0,
  });

/** The answer the first read of the run under way gives. */
let mayEdit = true;
/** Holds the first read open until the test opens the gate; null outside a run. */
let gate: Deferred.Deferred<boolean> | null = null;
/** Records the real owner requests, including a directory read that fails. */
const directoryReads: CustomerListRequest[] = [];
let directoryAnswer: Effect.Effect<CustomerListResponse, typeof CustomerListInternalProblemSchema.Type> =
  Effect.succeed({ items: [] });
let firstReadStarted: Deferred.Deferred<boolean> | null = null;

const Owner = RecordsApi.prefix('/merchandise-api');
const Customers = CustomerListApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api', 'party-registry': '/party-registry-api' }).application,
  serveApi(
    Owner,
    HttpApiBuilder.group(Owner, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.gen(function* readOrders() {
          if (payload.view?.ordersLimit !== 0) {
            if (firstReadStarted !== null) {
              yield* Deferred.succeed(firstReadStarted, true);
            }
            if (gate !== null) {
              yield* Deferred.await(gate);
            }
          }
          return recordsOf(mayEdit);
        }),
      ),
    ),
  ),
  serveApi(
    Customers,
    HttpApiBuilder.group(Customers, 'customerList', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          directoryReads.push(payload);
          return directoryAnswer;
        }),
      ),
    ),
  ),
);

const directoryRequests = () => directoryReads.length;

/**
 * One document's preload with the first read held open. Returns how many directory requests had started while that
 * read was still open; the read then returns with `answer` and the preload finishes.
 */
const preloadWhileReadOpen = Effect.fn('orders-directory-test.preload')(function* preloadWhileReadOpen(
  who: ModulePageContext,
  answer: boolean,
) {
  mayEdit = answer;
  ordersPageData.invalidate();
  orderCountsData.invalidate();
  customerDirectoryData.invalidate();
  directoryReads.length = 0;
  const opened = yield* Deferred.make<boolean>();
  gate = opened;
  const started = yield* Deferred.make<boolean>();
  firstReadStarted = started;
  const done = browserRuntime.runPromise(preloadOrdersPage(who.legalEntityId, PAGE_SIZE, who));
  yield* Deferred.await(started);
  // Every request the preload starts next to the held read has reached its server (and been answered) by now; a
  // directory request sent with the page is counted, one that waits for the read cannot have been sent.
  yield* networkQuietExcept(1);
  const whileOpen = directoryRequests();
  yield* Deferred.succeed(opened, true);
  yield* Effect.promise(() => done);
  if (answer || whileOpen > 0) {
    // A stale directory preload returns its cached value while HTTP revalidation finishes in the background.
    yield* waitUntil(() => {
      const snapshot = customerDirectoryData.snapshot(who.legalEntityId);
      return snapshot.state !== 'pending' && !snapshot.refreshing;
    });
  }
  gate = null;
  firstReadStarted = null;
  return whileOpen;
});

const setUp = pinTestDocument.pipe(
  Effect.andThen(
    Effect.sync(() => {
      directoryAnswer = Effect.succeed({ items: [] });
    }),
  ),
);

it.live('a remembered yes starts the customer list before the first orders read returns', () =>
  Effect.gen(function* rememberedYes() {
    yield* setUp;
    const who = contextOf(REMEMBERED_PERSON);
    expect(yield* preloadWhileReadOpen(who, true)).toBe(0);
    expect(globalThis.sessionStorage.getItem(storageKeyOf(who))).toBe(REMEMBERED_YES);

    expect(yield* preloadWhileReadOpen(who, true)).toBe(1);
  }).pipe(Effect.provide(network)),
);

it.live('a yes kept by an earlier document of the tab starts the customer list with the first read', () =>
  Effect.gen(function* earlierDocument() {
    yield* setUp;
    const who = contextOf(EARLIER_DOCUMENT_PERSON);
    globalThis.sessionStorage.setItem(storageKeyOf(who), REMEMBERED_YES);

    expect(yield* preloadWhileReadOpen(who, true)).toBe(1);
  }).pipe(Effect.provide(network)),
);

it.live('with nothing remembered the customer list starts only after the first read says the person may edit', () =>
  Effect.gen(function* nothingRemembered() {
    yield* setUp;
    const who = contextOf(FRESH_PERSON);
    expect(yield* preloadWhileReadOpen(who, true)).toBe(0);
    expect(directoryRequests()).toBe(1);
  }).pipe(Effect.provide(network)),
);

it.live('a remembered yes is forgotten when the first read says the person may not edit', () =>
  Effect.gen(function* revoked() {
    yield* setUp;
    const who = contextOf(REVOKED_PERSON);
    expect(yield* preloadWhileReadOpen(who, true)).toBe(0);
    // Remembered yes: the directory starts with the page, and the read then says no, which forgets the answer.
    expect(yield* preloadWhileReadOpen(who, false)).toBe(1);

    expect(globalThis.sessionStorage.getItem(storageKeyOf(who))).toBeNull();
    expect(yield* preloadWhileReadOpen(who, false)).toBe(0);
    expect(directoryRequests()).toBe(0);
  }).pipe(Effect.provide(network)),
);

it.live('a remembered yes of one person or company is not used for another', () =>
  Effect.gen(function* otherScope() {
    yield* setUp;
    expect(yield* preloadWhileReadOpen(contextOf(FIRST_PERSON), true)).toBe(0);

    expect(yield* preloadWhileReadOpen(contextOf(SECOND_PERSON), true)).toBe(0);
    expect(yield* preloadWhileReadOpen(contextOf(FIRST_PERSON, OTHER_COMPANY), true)).toBe(0);
  }).pipe(Effect.provide(network)),
);

it.live('a customer list that fails at once is asked for once, not again when the first read returns', () =>
  Effect.gen(function* failingDirectory() {
    yield* setUp;
    const who = contextOf(FAILING_DIRECTORY_PERSON);
    expect(yield* preloadWhileReadOpen(who, true)).toBe(0);
    directoryAnswer = Effect.fail(
      CustomerListInternalProblemSchema.make({
        detail: 'The customer list is down',
        status: 500,
        title: 'Customer list unavailable',
        type: 'https://ontos.dev/problems/customer-list-internal',
      }),
    );

    expect(yield* preloadWhileReadOpen(who, true)).toBe(1);
    expect(directoryRequests()).toBe(1);
  }).pipe(Effect.provide(network)),
);
