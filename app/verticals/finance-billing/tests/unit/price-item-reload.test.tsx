// @rstest-environment happy-dom
// The price list item editor on the finance page while the ledger reloads in the background (a live change, the 20 s
// freshness window, a settled write). The strict ledger store reads `pending` during such a reload; the open dialog
// must stay mounted: typed input, its unsaved status and the leave question survive and a save sends the typed draft,
// while a draft with nothing typed takes the reloaded item. Before, the price list tab unmounted for the reload and the
// dialog closed with everything typed into it. The plan, accounting and recurring tabs sit behind the same gate.
import { saveLabelsFor } from '@app/admin-ui';
import type { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { constVoid } from 'effect/Function';
import { Deferred, Effect, Option, Redacted, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { RecordsPage } from '../../src/routes/[lang]/finance/page.tsx';
import { financeBrowserRuntime } from '../../src/runtime/browser.ts';

/** The part of the router state the page reads. */
interface TestRouterState {
  readonly location: { readonly search: { readonly resourceId?: string }; readonly searchStr: string };
}
const mocks = rstest.hoisted(() => ({ apply: rstest.fn(), records: rstest.fn() }));
// The reference credentials a finance command carries come from the Shell's gateway, which a unit test does not have.
rstest.mock('@app/shared-contracts', () => ({
  ...rstest.requireActual<{
    readonly makeReferenceGatewayCredentials: typeof makeReferenceGatewayCredentials;
  }>('@app/shared-contracts'),
  makeReferenceGatewayCredentials: () => Effect.succeed(Redacted.make('credentials')),
}));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: mocks.apply }));
rstest.mock('@app/merchandise/clients/records', () => ({ listProducts: () => Effect.never }));
rstest.mock('@app/party-registry/api/client', () => ({ listCustomers: () => Effect.never }));
rstest.mock('@app/sales-pipeline/clients/records', () => ({ listOpportunities: () => Effect.never }));
rstest.mock('@app/legal-agreements/clients/records', () => ({ executeRecords: () => Effect.never }));
rstest.mock('@app/property-portfolio/clients/records', () => ({ executeRecords: () => Effect.never }));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useNavigate: () => () => Promise.resolve(),
  useRouterState: <Selected,>(options?: { readonly select?: (state: TestRouterState) => Selected }) => {
    const state: TestRouterState = { location: { search: {}, searchStr: '?tab=cenik' } };
    return options?.select === undefined ? state : options.select(state);
  },
}));
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const labels = saveLabelsFor('cs');
const name = 'price-name';
const amount = 'price-amount';
const close = 'finance-billing.financeUi.priceList.close';
const itemId = 'price-item-1';

/** The ledger at `revision` with one price list item; every read is a new object, as a reload returns. */
const ledgerAt = (revision: number, unitPriceMinor: number): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    businessDate: '2026-10-05',
    canWrite: true,
    indicators: {
      costMinor: 0,
      costVarianceMinor: 0,
      draftCount: 0,
      grossOutstandingMinor: 0,
      openIncomingInvoices: 0,
      openInvoices: 0,
      openOutgoingInvoices: 0,
      overdueInvoices: 0,
      payablesOutstandingMinor: 0,
      plannedCostMinor: 0,
      plannedRevenueMinor: 0,
      receivablesOutstandingMinor: 0,
      revenueMinor: 0,
      revenueVarianceMinor: 0,
    },
    referenceDate: '2026-10-05',
    revision,
    state: {
      financialPlanEntries: [],
      invoices: [],
      priceList: [
        {
          active: true,
          id: itemId,
          name: 'server-name',
          unitPriceMinor,
          updatedAt: '2026-10-01T08:00:00Z',
          vatRate: 21,
        },
      ],
    },
  });

const context: ModulePageProps['context'] = {
  legalEntityId: 'company-a',
  principalId: 'accountant-a',
  tenantId: 'a0000000-0000-4000-8000-000000000001',
};

/** Lets running reads and saves take a step, then flushes React's updates. */
const settle: Effect.Effect<void> = Effect.promise(() => financeBrowserRuntime.runPromise(Effect.yieldNow)).pipe(
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
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ container, root });
    root.render(<RecordsPage context={context} />);
  });

const buttons = (label: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.textContent?.trim() === label || button.getAttribute('aria-label') === label,
  );
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

/** Opens the price list tab with the ledger at revision 3 and opens the item's editor. */
const openItem = Effect.gen(function* open() {
  yield* render();
  yield* waitUntil(() => buttons('Upravit server-name').length === 1);
  yield* click('Upravit server-name');
  yield* waitUntil(() => Option.isSome(maybeField(name)));
});

/** Someone else's change of finance data: the ledger reloads and answers once `gate` opens. */
const reloadThrough = (gate: Deferred.Deferred<RecordsResponse>) =>
  Effect.gen(function* reload() {
    mocks.records.mockReturnValue(Deferred.await(gate));
    yield* acted(() => {
      globalThis.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['finance-billing'] } }));
    });
  });

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.records.mockReset();
  mocks.records.mockImplementation(() => Effect.succeed(ledgerAt(3, 10_000)));
  mocks.apply.mockReset();
  mocks.apply.mockReturnValue(Effect.succeed({ revision: 5 }));
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

describe('price list item editor across a background reload', () => {
  it.live('keeps typed input, its status and the leave question; Save sends the typed draft', () =>
    Effect.gen(function* typedSurvives() {
      yield* openItem;
      yield* type(name, 'typed-name');
      expect(text()).toContain(labels.unsaved);

      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      // While the ledger reads `pending`, the dialog and the typed value stay on screen.
      expect(value(name)).toBe('typed-name');
      expect(text()).toContain(labels.unsaved);

      // The reload brings a newer revision of the ledger; the item itself is unchanged.
      yield* Deferred.succeed(gate, ledgerAt(4, 10_000));
      yield* waitUntil(() => mocks.records.mock.calls.length >= 2);
      yield* waitUntil(() => buttons(labels.save).length > 0);
      expect(value(name)).toBe('typed-name');
      expect(text()).toContain(labels.unsaved);
      expect(button(labels.save).disabled).toBe(false);

      yield* click(close);
      expect(buttons(labels.stay)).toHaveLength(1);
      yield* click(labels.stay);
      yield* waitUntil(() => buttons(labels.stay).length === 0);
      expect(value(name)).toBe('typed-name');

      mocks.records.mockImplementation(() => Effect.succeed(ledgerAt(5, 10_000)));
      yield* click(labels.save);
      yield* waitUntil(() => mocks.apply.mock.calls.length > 0);
      expect(mocks.apply.mock.calls[0]?.[0]).toMatchObject({
        command: { _tag: 'UpsertPriceListItem', id: itemId, name: 'typed-name' },
      });
    }),
  );

  it.live('a draft with nothing typed takes the reloaded item', () =>
    Effect.gen(function* cleanFollows() {
      yield* openItem;
      const opened = value(amount);
      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      expect(value(amount)).toBe(opened);
      yield* Deferred.succeed(gate, ledgerAt(4, 25_000));
      yield* waitUntil(() => value(amount) !== opened && value(amount) !== undefined);
      expect(text()).not.toContain(labels.unsaved);
      expect(button(labels.save).disabled).toBe(true);
    }),
  );
});
