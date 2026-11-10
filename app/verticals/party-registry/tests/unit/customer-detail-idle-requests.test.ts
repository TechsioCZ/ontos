// @rstest-environment happy-dom
// How many owner reads an idle customer detail page sends while other modules commit every 2 s, as on a busy stage
// tenant: the real strict store, mounted as the page mounts it, with the owner clients replaced and the clock faked.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { Effect } from 'effect';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { useEffect, useSyncExternalStore } from 'react';
import type { CounterpartyRef } from '../../shared/resources/counterparty.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { executeCounterpartyRead } from '../../src/api/counterparty-read-client.ts';
import { executePartyContactPoints } from '../../src/api/party-contact-points-client.ts';
import { executePartyDetail } from '../../src/api/party-detail-client.ts';
import { executePartyOfficialIdentifierHistory } from '../../src/api/party-official-identifier-history-client.ts';
import { customerDetailData } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';
import { customerDetailPageData } from '../../src/routes/[lang]/prodej/zakaznici/customer-detail-page-data.ts';
import type { CustomerDetailPageInput } from '../../src/routes/[lang]/prodej/zakaznici/customer-detail-page-data.ts';

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
const counterpartyRef: CounterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId,
};
const partyRef: PartyRef = {
  moduleId: 'party.registry',
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
};
const input: CustomerDetailPageInput = { context, counterpartyId: counterpartyRef.resourceId };

const serve = () => {
  // SAFETY: the stub answers the fields the page load checks: identity, company, customer role and party reference.
  rstest.mocked(executeCounterpartyRead).mockImplementation(
    () =>
      Effect.succeed({
        counterpartyRef,
        currentRoles: [{ roleType: 'CUSTOMER', state: 'ACTIVE', validTo: null }],
        legalEntityRef: { resourceId: context.legalEntityId, tenantId },
        party: { canonicalPartyRef: partyRef },
      }) as never,
  );
  // SAFETY: the stub answers the one field the page load reads, the resolved party reference.
  rstest
    .mocked(executePartyDetail)
    .mockImplementation(() => Effect.succeed({ resolution: { canonicalPartyRef: partyRef } }) as never);
  // SAFETY: the sections are rendered by the page, not read by the load.
  rstest.mocked(executePartyContactPoints).mockImplementation(() => Effect.succeed({ items: [] }) as never);
  // SAFETY: the sections are rendered by the page, not read by the load.
  rstest.mocked(executePartyOfficialIdentifierHistory).mockImplementation(() => Effect.succeed({ items: [] }) as never);
};

/** Every owner read the page sent (one page load is four reads). */
const reads = () =>
  [executeCounterpartyRead, executePartyDetail, executePartyContactPoints, executePartyOfficialIdentifierHistory]
    .map((client) => rstest.mocked(client).mock.calls.length)
    .reduce((sum, calls) => sum + calls, 0);

/** The detail page's subscription and `ensure`, as `[id]/page.tsx` mounts them. */
const useDetailPage = () => {
  const snapshot = useSyncExternalStore(
    (listener) => customerDetailPageData.subscribe(listener, input),
    () => customerDetailPageData.snapshot(input),
  );
  useEffect(() => {
    customerDetailPageData.ensure(input);
  }, []);
  return snapshot.state;
};

const idle = (seconds: number): Effect.Effect<void> =>
  seconds <= 0
    ? Effect.void
    : Effect.promise(() => act(() => rstest.advanceTimersByTimeAsync(1000))).pipe(
        Effect.andThen(Effect.suspend(() => idle(seconds - 1))),
      );

/** Reads of the idle page while `change` arrives every 2 s for a minute. */
const readsPerBusyMinute = (change: () => Event) =>
  Effect.gen(function* busyMinute() {
    const { result, unmount } = renderHook(useDetailPage);
    yield* idle(5);
    expect(result.current).toBe('ready');
    const before = reads();
    for (let event = 0; event < 30; event += 1) {
      globalThis.dispatchEvent(change());
      yield* idle(2);
    }
    unmount();
    return reads() - before;
  });

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  rstest.resetAllMocks();
  customerDetailData.invalidate();
  customerDetailPageData.invalidate();
  serve();
});

afterEach(() => {
  cleanup();
  rstest.useRealTimers();
  rstest.unstubAllGlobals();
});

it.effect('an idle customer detail ignores other modules committing every 2 s', () =>
  Effect.gen(function* otherModulesBusy() {
    const perMinute = yield* readsPerBusyMinute(
      () => new CustomEvent(moduleChangeEvent, { detail: { apps: ['finance-billing', 'merchandise', 'shell'] } }),
    );
    // The freshness window alone: one page load (four reads) every 20 s.
    expect(perMinute).toBe(12);
  }),
);

it.effect('party-registry changes still reload the customer detail', () =>
  Effect.gen(function* ownChanges() {
    const perMinute = yield* readsPerBusyMinute(
      () => new CustomEvent(moduleChangeEvent, { detail: { apps: ['party-registry'] } }),
    );
    expect(perMinute).toBe(120);
  }),
);

it.effect('a change event without an app list still reloads the customer detail every time (as before scoping)', () =>
  Effect.gen(function* unscopedBusy() {
    const perMinute = yield* readsPerBusyMinute(() => new Event(moduleChangeEvent));
    expect(perMinute).toBe(120);
  }),
);
