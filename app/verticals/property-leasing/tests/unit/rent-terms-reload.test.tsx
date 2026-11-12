// @rstest-environment happy-dom
// The rent panel of a lease while the leases reload in the background (a live change, the 20 s freshness window, a
// settled write). The strict lease store reads `pending` during such a reload; the open panel must stay mounted: typed
// input, its unsaved status and the leave question survive, a save goes out against the revision the draft was read
// at, and a draft with nothing typed takes the reloaded rent.
import { saveLabelsFor } from '@app/admin-ui';
import type { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { constVoid } from 'effect/Function';
import { Deferred, Effect, Option, Redacted, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { leaseInputOf, leaseRecords } from '../../src/routes/[lang]/najmy/lease-occupant.ts';
import { RecordsPage } from '../../src/routes/[lang]/najmy/page.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { leaseDraft, occupancyRef } from '../fixtures/occupancy-draft.ts';

/** The part of the router state the page reads. */
interface TestRouterState {
  readonly location: { readonly search: { readonly resourceId?: string }; readonly searchStr: string };
}
const mocks = rstest.hoisted(() => ({
  apply: rstest.fn(),
  records: rstest.fn(),
  searchStr: '',
}));
// The reference credentials a lease command carries come from the Shell's gateway, which a unit test does not have.
rstest.mock('@app/shared-contracts', () => ({
  ...rstest.requireActual<{
    readonly makeReferenceGatewayCredentials: typeof makeReferenceGatewayCredentials;
  }>('@app/shared-contracts'),
  makeReferenceGatewayCredentials: () => Effect.succeed(Redacted.make('credentials')),
}));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: mocks.apply }));
rstest.mock('@app/party-registry/api/client', () => ({
  createCustomer: () => Effect.never,
}));
rstest.mock('@app/party-registry/apis/counterparty-read/client', () => ({
  executeCounterpartyRead: () => Effect.never,
}));
rstest.mock('@app/party-registry/apis/party-detail/client', () => ({
  executePartyDetail: () => Effect.never,
}));
rstest.mock('../../src/routes/[lang]/najmy/party-customers.ts', () => ({
  listCustomers: () => Effect.succeed([]),
}));
rstest.mock('@app/party-registry/apis/parties-search/client', () => ({
  loadPartiesClient: () => Effect.never,
}));
rstest.mock('@app/property-portfolio/clients/records', () => ({
  executeRecords: () => Effect.succeed({ assets: [], properties: [], revision: 1, units: [] }),
}));
rstest.mock('@app/legal-agreements/clients/records', () => ({
  executeRecords: () => Effect.succeed({ contracts: [], documents: [], revision: 1 }),
}));
rstest.mock('@app/finance-billing/clients/lease-invoices', () => ({
  executeLeaseInvoices: () => Effect.never,
  LEASE_INVOICES_PAGE_LIMIT_MAX: 100,
}));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: () => Effect.never }));
rstest.mock('@app/facility-operations/ui/record-discussion', () => ({
  PartyDocuments: () => null,
  PropertyEquipment: () => null,
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useNavigate: () => () => Promise.resolve(),
  useRouterState: <Selected,>(options?: { readonly select?: (state: TestRouterState) => Selected }) => {
    const state: TestRouterState = { location: { search: {}, searchStr: mocks.searchStr } };
    return options?.select === undefined ? state : options.select(state);
  },
}));
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const labels = saveLabelsFor('cs');
const monthly = 'occupancy-rent-monthly';
const paymentDay = 'occupancy-rent-payment-day';
const editRent = 'property-leasing.rent.edit';
const close = 'property-leasing.demo.close';

/** The leases at `revision`; every read is a new object, as a reload returns. */
const recordsAt = (revision: number, day: number): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    canWrite: true,
    occupancies: [{ ...leaseDraft, rentTerms: { ...leaseDraft.rentTerms, paymentDay: day }, state: 'ACTIVE' }],
    revision,
  });

const context: ModulePageProps['context'] = {
  legalEntityId: 'company-a',
  principalId: 'manager-a',
  tenantId: occupancyRef.tenantId,
};

/** Lets running reads and saves take a step, then flushes React's updates. */
const settle: Effect.Effect<void> = Effect.promise(() => browserRuntime.runPromise(Effect.yieldNow)).pipe(
  Effect.andThen(
    Effect.sync(() => {
      act(constVoid);
    }),
  ),
);
/** Runs `step` inside React's act, then lets what it started settle. */
const acted = (step: () => void): Effect.Effect<void> =>
  Effect.sync(() => {
    act(() => {
      step();
    });
  }).pipe(Effect.andThen(settle));
/** Lets the page work until `condition` holds; fails the test when it never does. */
const waitUntil = (condition: () => boolean, attempt = 0): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (condition() || attempt >= 400) {
      return Effect.sync(() => {
        expect(condition()).toBe(true);
      });
    }
    return settle.pipe(Effect.andThen(waitUntil(condition, attempt + 1)));
  });

const roots: { readonly container: HTMLElement; readonly root: Root }[] = [];
const render = () =>
  acted(() => {
    mocks.searchStr = `?resourceId=${occupancyRef.resourceId}`;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ container, root });
    root.render(<RecordsPage context={context} />);
  });

const buttons = (label: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === label);
const button = (label: string): HTMLButtonElement => {
  const [found] = buttons(label);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};
const maybeField = (id: string) => Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`));
const value = (id: string) =>
  maybeField(id).pipe(
    Option.map((input) => input.value),
    Option.getOrUndefined,
  );
const text = () => document.body.textContent ?? '';
const type = (id: string, typed: string) =>
  acted(() => {
    const input = Option.getOrThrow(maybeField(id));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, typed);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = (label: string) => acted(() => button(label).click());
/** A button of the rent panel itself; the lease page shows other forms with their own Uložit. */
const panelButton = (label: string): HTMLButtonElement => {
  const panel = maybeField(monthly).pipe(
    Option.flatMapNullishOr((input) => input.closest('[role="dialog"]')),
    Option.getOrUndefined,
  );
  const found = [...(panel?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};
const clickPanel = (label: string) => acted(() => panelButton(label).click());

/** Opens the lease with the leases at revision 7 and opens its rent panel. */
const openRent = Effect.gen(function* open() {
  yield* render();
  yield* waitUntil(() => buttons(editRent).length === 1 && !button(editRent).disabled);
  yield* click(editRent);
  yield* waitUntil(() => Option.isSome(maybeField(monthly)));
});

/** A background reload of the leases that answers once `gate` opens, with someone else's payment day. */
const reloadThrough = (gate: Deferred.Deferred<RecordsResponse>) =>
  Effect.gen(function* reload() {
    mocks.records.mockReturnValue(Deferred.await(gate));
    yield* acted(() => leaseRecords.invalidate());
  });

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.records.mockReset();
  mocks.records.mockImplementation(() => Effect.succeed(recordsAt(7, 15)));
  mocks.apply.mockReset();
  mocks.apply.mockReturnValue(Effect.succeed({ resourceRef: occupancyRef, revision: 9 }));
  leaseRecords.invalidate();
});

afterEach(() => {
  for (const { container, root } of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  rstest.unstubAllGlobals();
});

describe('rent panel across a background reload', () => {
  it.live('keeps typed input, its status and the leave question; Save sends it against the old revision', () =>
    Effect.gen(function* typedSurvives() {
      yield* openRent;
      yield* type(monthly, '20000');
      expect(text()).toContain(labels.unsaved);

      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      // While the leases read `pending`, the panel and the typed value stay on screen.
      expect(value(monthly)).toBe('20000');
      expect(text()).toContain(labels.unsaved);

      yield* Deferred.succeed(gate, recordsAt(8, 20));
      yield* waitUntil(() => mocks.records.mock.calls.length >= 2);
      yield* waitUntil(() => leaseRecords.snapshot(leaseInputOf(context)).state === 'ready');
      expect(value(monthly)).toBe('20000');
      // A dirty draft keeps its whole input, not just the typed field.
      expect(value(paymentDay)).toBe('15');
      expect(text()).toContain(labels.unsaved);
      expect(panelButton(labels.save).disabled).toBe(false);

      yield* clickPanel(close);
      expect(buttons(labels.stay)).toHaveLength(1);
      yield* click(labels.stay);
      yield* waitUntil(() => buttons(labels.stay).length === 0);
      expect(value(monthly)).toBe('20000');

      mocks.records.mockImplementation(() => Effect.succeed(recordsAt(8, 20)));
      yield* clickPanel(labels.save);
      yield* waitUntil(() => mocks.apply.mock.calls.length > 0);
      expect(mocks.apply.mock.calls[0]?.[0]).toMatchObject({
        command: { _tag: 'SetRentTerms', rentTerms: { monthlyRentMinor: 2_000_000, paymentDay: 15 } },
        expectedRevision: 7,
      });
    }),
  );

  it.live('a draft with nothing typed takes the reloaded rent', () =>
    Effect.gen(function* cleanFollows() {
      yield* openRent;
      expect(value(paymentDay)).toBe('15');
      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      expect(value(paymentDay)).toBe('15');
      yield* Deferred.succeed(gate, recordsAt(8, 20));
      yield* waitUntil(() => value(paymentDay) === '20');
      expect(text()).not.toContain(labels.unsaved);
      expect(panelButton(labels.save).disabled).toBe(true);
    }),
  );
});
