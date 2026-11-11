// The customers list across a reload: the page's own read of the real strict store, with only the generated list and
// segment clients replaced. A live change, a settled write and the freshness window make the strict store read as
// pending, so without a held read the table drops to its loading rows and the stat tiles to dashes.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { Deferred, Effect, Schema } from 'effect';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { CustomerListForbiddenProblemSchema, CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import { executeCustomerList } from '../../src/api/customer-list-client.ts';
import { customerSegmentsFor } from '../../src/api/customer-segments-client.ts';
import {
  customersData,
  customersQuery,
  useCustomersSnapshot,
} from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';

rstest.mock('../../src/api/customer-list-client.ts');
rstest.mock('../../src/api/customer-segments-client.ts');

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
    globalThis.dispatchEvent(new Event(moduleChangeEvent));
  });
};

beforeEach(() => {
  rstest.resetAllMocks();
  rstest.mocked(customerSegmentsFor).mockReturnValue(Effect.succeed(new Map()));
  rstest.mocked(executeCustomerList).mockReturnValue(Effect.succeed({ items: [customerOf('Before')] }));
  customersData.invalidate();
  shown.length = 0;
});
afterEach(cleanup);

it.live('the rows stay on screen while the same register reloads', () =>
  Effect.gen(function* held() {
    yield* customersData.read(customersQuery(company));
    const { result } = renderHook(useTable, { initialProps: { context: company } });
    expect(result.current).toBe('rows:Before');

    const gate = yield* Deferred.make<boolean>();
    rstest
      .mocked(executeCustomerList)
      .mockReturnValue(Deferred.await(gate).pipe(Effect.as({ items: [customerOf('After')] })));
    shown.length = 0;
    liveChange();
    expect(customersData.snapshot(customersQuery(company)).state).toBe('pending');
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown)).toEqual(new Set(['rows:Before']));

    yield* Deferred.succeed(gate, true);
    yield* Effect.promise(() => waitFor(() => expect(result.current).toBe('rows:After')));
    expect(shown.filter((table) => !table.startsWith('rows:'))).toEqual([]);
  }),
);

it.live('another company never shows the rows held for the company before it', () =>
  Effect.gen(function* otherScope() {
    yield* customersData.read(customersQuery(company));
    const { rerender, result } = renderHook(useTable, { initialProps: { context: company } });
    expect(result.current).toBe('rows:Before');

    const gate = yield* Deferred.make<boolean>();
    rstest
      .mocked(executeCustomerList)
      .mockReturnValue(Deferred.await(gate).pipe(Effect.as({ items: [customerOf('Theirs')] })));
    liveChange();
    shown.length = 0;
    rerender({ context: otherCompany });
    expect(new Set(shown)).toEqual(new Set(['pending']));
    yield* Deferred.succeed(gate, true);
  }),
);

it.live('a refused reload takes the held rows away at once', () =>
  Effect.gen(function* refused() {
    yield* customersData.read(customersQuery(company));
    const { result } = renderHook(useTable, { initialProps: { context: company } });
    expect(result.current).toBe('rows:Before');

    rstest.mocked(executeCustomerList).mockReturnValue(Effect.fail(denied));
    liveChange();
    yield* Effect.promise(() => waitFor(() => expect(result.current).toBe('failed')));
  }),
);

it.effect('a list reopened after its rows went stale shows them at once and reloads once', () =>
  Effect.gen(function* reopenedList() {
    // The freshness window (20 s) has to pass while the list is not mounted, so this case runs on a fake clock.
    rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      yield* customersData.read(customersQuery(company));
      const first = renderHook(useTable, { initialProps: { context: company } });
      expect(first.result.current).toBe('rows:Before');
      first.unmount();

      yield* Effect.promise(() => act(() => rstest.advanceTimersByTimeAsync(30_000)));
      const loadsBefore = rstest.mocked(executeCustomerList).mock.calls.length;
      shown.length = 0;
      const second = renderHook(useTable, { initialProps: { context: company } });
      // The first render already has the rows.
      expect(shown[0]).toBe('rows:Before');
      expect(shown).not.toContain('pending');
      // The page's own mount effect (`ensure(query)`) starts the one background reload that follows.
      act(() => {
        customersData.ensure(customersQuery(company));
      });
      yield* Effect.promise(() => act(() => rstest.advanceTimersByTimeAsync(1000)));
      expect(rstest.mocked(executeCustomerList).mock.calls.length - loadsBefore).toBe(1);
      expect(second.result.current).toBe('rows:Before');
      second.unmount();
    } finally {
      rstest.useRealTimers();
    }
  }),
);
