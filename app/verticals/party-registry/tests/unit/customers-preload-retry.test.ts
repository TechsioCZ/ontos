// @rstest-environment happy-dom
import { LIST_WARM_ROWS } from '@app/admin-ui';
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'effect-rstest';
import { Deferred, Effect, Schema } from 'effect';
import { pageDataScopeKey } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import { CounterpartyReadApi, CounterpartyReadForbiddenProblemSchema } from '../../shared/apis/counterparty-read.ts';
import type { CounterpartyReadRequest } from '../../shared/apis/counterparty-read.ts';
import {
  customerDetailData,
  usePrefetchCustomerDetails,
} from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const context = {
  legalEntityId: '60000000-0000-4000-8000-000000000001',
  principalId: 'principal-1',
  tenantId,
};
const scope = pageDataScopeKey(context, 'party.registry') ?? '';
const rows = Array.from({ length: 201 }, (_, index) => {
  const suffix = String(index + 1).padStart(12, '0');
  const counterpartyId = `30000000-0000-4000-8000-${suffix}`;
  const partyId = `40000000-0000-4000-8000-${suffix}`;
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
    partyId,
    partyRef: {
      moduleId: 'party.registry',
      resourceId: partyId,
      resourceType: 'party.registry.party',
      tenantId,
    },
    partyRevision: 7,
    phone: null,
    status: 'ACTIVE',
    vatId: null,
  });
});
const denied = Schema.decodeSync(CounterpartyReadForbiddenProblemSchema)({
  _tag: 'CounterpartyReadForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});

afterEach(cleanup);

it.live('visible preloads warm each batch once, with bounded concurrency and no retry of failed rows', () =>
  Effect.gen(function* retryFailedVisiblePreloads() {
    yield* pinTestDocument;
    customerDetailData.invalidate();
    const initialGate = yield* Deferred.make<true>();
    const twoActive = yield* Deferred.make<true>();
    const reads: CounterpartyReadRequest[] = [];
    let active = 0;
    let peak = 0;
    const api = CounterpartyReadApi.prefix('/party-registry-api');
    const network = browserNetwork(
      shellGatewayIssuer({ 'party-registry': '/party-registry-api' }).application,
      serveApi(
        api,
        HttpApiBuilder.group(api, 'counterpartyRead', (group) =>
          group.handle('execute', ({ payload }) =>
            Effect.acquireUseRelease(
              Effect.gen(function* startRead() {
                reads.push(payload);
                active += 1;
                peak = Math.max(peak, active);
                if (active === 2) {
                  yield* Deferred.succeed(twoActive, true);
                }
              }),
              () => Deferred.await(initialGate).pipe(Effect.andThen(Effect.fail(denied))),
              () =>
                Effect.sync(() => {
                  active -= 1;
                }),
            ),
          ),
        ),
      ),
    );
    yield* Effect.gen(function* checkVisiblePreloads() {
      // Only the first rows are warmed; every other row waits for its intent.
      const visible = rows.slice(0, LIST_WARM_ROWS);
      const overflow = rows.slice(LIST_WARM_ROWS);
      const allFailed = () =>
        visible.every((customer) => customerDetailData.snapshot({ customer, scope }).state === 'failed');
      const { rerender, unmount } = renderHook(() => usePrefetchCustomerDetails(context, rows));

      yield* Deferred.await(twoActive);
      expect(active).toBe(2);
      expect(reads).toHaveLength(2);
      yield* Deferred.succeed(initialGate, true);
      yield* waitUntil(allFailed);
      expect(allFailed()).toBe(true);
      expect(active).toBe(0);
      expect(reads).toHaveLength(LIST_WARM_ROWS);
      rerender();
      expect(reads).toHaveLength(LIST_WARM_ROWS);

      // A batch is warmed once: an invalidation or another render does not start a second one for the same rows.
      act(() => customerDetailData.invalidate());
      rerender();
      yield* Effect.sleep('10 millis');
      expect(reads).toHaveLength(LIST_WARM_ROWS);
      expect(peak).toBe(2);
      expect(overflow.map((customer) => customerDetailData.snapshot({ customer, scope }).state)).toEqual(
        overflow.map(() => 'pending'),
      );
      unmount();
    }).pipe(Effect.provide(network));
  }),
);
