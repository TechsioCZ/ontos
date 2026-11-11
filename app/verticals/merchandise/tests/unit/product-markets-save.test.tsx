// @rstest-environment happy-dom
// The "Trhy" tab of the product editor: a market offer decides what a live e-shop sells, so its switch changes only
// the draft. The tab's one Save button sends the changed offers, each naming the offer the draft was read from, so a
// newer change by someone else is refused instead of overwritten. Only the generated markets client, the i18n runtime
// and the router blocker are replaced.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ManageMarketsActionConflictProblemSchema } from '../../shared/apis/manage-markets-action.ts';
import { MarketIdSchema } from '../../shared/domain/market-offers.ts';
import type { ProductMarket } from '../../shared/domain/market-offers.ts';
import { ProductIdSchema } from '../../shared/domain/merchandise-model.ts';
import { executeManageMarkets } from '../../src/api/manage-markets-action-client.ts';
import { MarketsPanel } from '../../src/routes/[lang]/provoz/produkty/product-markets.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-markets-action-client.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ proceed: constVoid, reset: constVoid, status: 'idle' }),
}));

const labels = saveLabelsFor('cs');
const SK = Schema.decodeUnknownSync(MarketIdSchema)('6a000000-0000-4000-8000-0000000000a1');
const PL = Schema.decodeUnknownSync(MarketIdSchema)('6a000000-0000-4000-8000-0000000000a2');
const productId = Schema.decodeUnknownSync(ProductIdSchema)('product-1');
const markets: readonly ProductMarket[] = [
  { currency: 'EUR', grossPriceMinor: 1160, marketCode: 'AKROS-SK', marketId: SK, offered: true },
  { currency: 'PLN', marketCode: 'AKROS-PL', marketId: PL, offered: false },
];

const conflict = Schema.decodeSync(ManageMarketsActionConflictProblemSchema)({
  _tag: 'ManageMarketsActionConflictProblem',
  code: 'merchandise_revision_conflict',
  detail: 'Changed',
  status: 409,
  title: 'Conflict',
  type: 'urn:test:conflict',
});

/**
 * The server: the catalogue revision and each market's offer of the product. A command naming the offer it was read
 * from (`expectedOffered`) is refused when that offer changed since, as the merchandise owner refuses it.
 */
const register = { offers: new Map<string, boolean>(), revision: 4 };

const sent = () =>
  rstest.mocked(executeManageMarkets).mock.calls.map(([payload]) => ({
    command: payload.command,
    expectedRevision: payload.expectedRevision,
  }));

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const unmounts: (() => void)[] = [];
const committed: string[] = [];

const mount = async (revision: number) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MarketsPanel
        canManage
        markets={markets}
        onCommitted={(message) => {
          committed.push(message);
        }}
        onReload={constVoid}
        product={{ id: productId }}
        revision={revision}
      />,
    );
    await settle();
  });
  unmounts.push(() => {
    act(() => {
      root.unmount();
      container.remove();
    });
  });
};

const offerSwitch = (code: string): HTMLInputElement =>
  Option.getOrThrow(
    Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[name="market-offered-${code}"]`)),
  );

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const saveButton = (): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(labels.save)[0]));

const click = (element: HTMLElement) =>
  Effect.promise(() =>
    act(async () => {
      element.click();
      await settle();
    }),
  );

const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition() || attempt >= 400) {
    expect(condition()).toBe(true);
    return;
  }
  await act(settle);
  await waitUntil(condition, attempt + 1);
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  register.revision = 4;
  register.offers = new Map(markets.map((market) => [market.marketId, market.offered]));
  committed.length = 0;
  rstest.mocked(executeManageMarkets).mockImplementation(({ command }) =>
    Effect.suspend(() => {
      if (command._tag !== 'SetProductMarketOffer') {
        return Effect.die('Only offers are saved here');
      }
      if (command.expectedOffered !== undefined && command.expectedOffered !== register.offers.get(command.marketId)) {
        return Effect.fail(conflict);
      }
      register.offers.set(command.marketId, command.offered);
      return Effect.succeed({ entityIds: [], revision: register.revision });
    }),
  );
});

afterEach(() => {
  for (const unmount of unmounts) {
    unmount();
  }
  unmounts.length = 0;
  rstest.unstubAllGlobals();
});

it.effect('toggling a market offer writes nothing; Save writes the offer once', () =>
  Effect.gen(function* toggleThenSave() {
    yield* Effect.promise(() => mount(4));
    expect(saveButton().disabled).toBe(true);

    yield* click(offerSwitch('AKROS-PL'));
    expect(offerSwitch('AKROS-PL').checked).toBe(true);
    expect(sent()).toEqual([]);
    expect(saveButton().disabled).toBe(false);

    yield* click(saveButton());
    yield* Effect.promise(() => waitUntil(() => committed.length === 1));
    expect(sent()).toEqual([
      {
        command: { _tag: 'SetProductMarketOffer', expectedOffered: false, marketId: PL, offered: true, productId },
        expectedRevision: 4,
      },
    ]);
    expect(committed).toEqual(['merchandise.pages.products.markets.saved']);
    expect(register.offers.get(PL)).toBe(true);
  }),
);

it.effect('one Save sends every changed market once, each naming the offer it was read from', () =>
  Effect.gen(function* twoMarkets() {
    yield* Effect.promise(() => mount(4));
    yield* click(offerSwitch('AKROS-PL'));
    yield* click(offerSwitch('AKROS-SK'));
    // Switching a market back leaves nothing to send for it.
    yield* click(offerSwitch('AKROS-PL'));
    yield* click(offerSwitch('AKROS-PL'));
    expect(sent()).toEqual([]);

    yield* click(saveButton());
    yield* Effect.promise(() => waitUntil(() => committed.length === 1));
    expect(sent()).toEqual([
      {
        command: { _tag: 'SetProductMarketOffer', expectedOffered: true, marketId: SK, offered: false, productId },
        expectedRevision: 4,
      },
      {
        command: { _tag: 'SetProductMarketOffer', expectedOffered: false, marketId: PL, offered: true, productId },
        expectedRevision: 4,
      },
    ]);
  }),
);

it.effect('a save over a newer offer change by someone else is refused and keeps the draft', () =>
  Effect.gen(function* stale() {
    yield* Effect.promise(() => mount(4));
    // Someone else withdrew the product from AKROS-SK after the tab was read (shown as offered).
    register.offers.set(SK, false);
    yield* click(offerSwitch('AKROS-SK'));
    yield* click(offerSwitch('AKROS-PL'));
    yield* click(saveButton());
    yield* Effect.promise(() => waitUntil(() => (document.body.textContent ?? '').includes(labels.conflict)));
    // The first offer is refused; the rest of the save is not sent.
    expect(sent().map(({ command }) => command)).toEqual([
      { _tag: 'SetProductMarketOffer', expectedOffered: true, marketId: SK, offered: false, productId },
    ]);
    expect(register.offers.get(PL)).toBe(false);
    expect(committed).toEqual([]);
    expect(offerSwitch('AKROS-PL').checked).toBe(true);
    expect(buttons(labels.reloadLatest).length).toBe(1);
  }),
);
