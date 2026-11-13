// @rstest-environment happy-dom
// "Nastavit ceník" of a market without a price list: it puts the whole catalogue on the market's e-shops, so it asks
// first, naming the market, and sends one ConfigureMarket only after the confirmation. Only the merchandise client,
// the i18n runtime and the router blocker are replaced.
import { executeManageMarkets } from '@app/merchandise/apis/manage-markets-action/client';
import { Effect, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

import { MarketDefinitionSchema } from '../../shared/market-contracts.ts';
import { PriceListSetup } from '../../src/market-admin/price-list-setup.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('@app/merchandise/apis/manage-markets-action/client');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'cs',
    t: (key: string, values?: Record<string, string>) => [key, ...Object.values(values ?? {})].join(' '),
  }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '30000000-0000-4000-8000-000000000001';

const market = Schema.decodeUnknownSync(MarketDefinitionSchema)({
  channels: ['B2C'],
  definitionRevisionRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId,
  },
  effectivePeriod: { startsAt: '2026-01-01T00:00:00.000Z' },
  jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
  lifecycle: 'ACTIVE',
  marketCode: 'CZ_B2C',
  marketRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: marketId,
    resourceType: 'commerce.market-catalog.market',
    tenantId,
  },
  purpose: 'Czech retail commerce',
  revision: 1,
  sellingLegalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  supportedLocales: ['cs-CZ'],
});

/** The locale keys the stubbed i18n runtime shows as text. */
const copy = {
  confirm: 'commerce-market-catalog.detail.assortment.configureConfirm',
  description: 'commerce-market-catalog.detail.assortment.configureDescription',
  title: 'commerce-market-catalog.detail.assortment.configureTitle',
};

const commands = () => rstest.mocked(executeManageMarkets).mock.calls.length;

const settle = async (): Promise<void> => {
  await act(async () => {
    await browserRuntime.runPromise(Effect.yieldNow);
  });
};

const mounted: { container: HTMLElement; root: Root }[] = [];

const mount = async (onDone: (message: string) => void = constVoid) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(
      <PriceListSetup editable market={market} onAwaitingApproval={constVoid} onDone={onDone} revision={3} />,
    );
  });
  await settle();
};

const setupButton = () => document.querySelector<HTMLButtonElement>('[data-testid="market-price-list-setup"]');
const confirmButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === copy.confirm,
  );

const click = (button: HTMLButtonElement | null | undefined) =>
  Effect.promise(() =>
    act(async () => {
      expect(button).toBeDefined();
      button?.click();
    }),
  );

beforeEach(() => {
  rstest.mocked(executeManageMarkets).mockReset();
});

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

describe('setting up the price list of a market', () => {
  it.live('asks first, naming the market and the currency, and sends nothing until confirmed', () =>
    Effect.gen(function* asksFirst() {
      rstest
        .mocked(executeManageMarkets)
        .mockReturnValue(Effect.succeed({ entityIds: [], marketRevision: 1, revision: 4 }));
      yield* Effect.promise(() => mount());
      yield* click(setupButton());
      yield* Effect.promise(settle);
      expect(commands()).toBe(0);
      expect(document.body.textContent).toContain(`${copy.title} CZ_B2C`);
      expect(document.body.textContent).toContain(`${copy.description} CZ_B2C CZK`);
      expect(confirmButton()).toBeDefined();
    }),
  );

  it.live('sends one ConfigureMarket after the confirmation and reports it done', () =>
    Effect.gen(function* confirmed() {
      const done: string[] = [];
      rstest
        .mocked(executeManageMarkets)
        .mockReturnValue(Effect.succeed({ entityIds: [], marketRevision: 1, revision: 4 }));
      yield* Effect.promise(() =>
        mount((message) => {
          done.push(message);
        }),
      );
      yield* click(setupButton());
      yield* Effect.promise(settle);
      yield* click(confirmButton());
      yield* Effect.promise(settle);
      yield* Effect.sleep('100 millis');
      yield* Effect.promise(settle);
      expect(commands()).toBe(1);
      expect(done).toHaveLength(1);
      expect(confirmButton()).toBeUndefined();
    }),
  );
});
