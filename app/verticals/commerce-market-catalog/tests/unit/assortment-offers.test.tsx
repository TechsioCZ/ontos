// @rstest-environment happy-dom
// The e-shop switches of the price list: a switch changes only the section's draft, the one Save sends each changed
// offer once, and leaving with unsaved offers asks first. Only the merchandise and records clients, the i18n runtime
// and the router blocker are replaced.
import { executeManageMarkets } from '@app/merchandise/clients/manage-markets';
import { executeRecords } from '@app/merchandise/clients/records';
import { RecordsResponseSchema } from '@app/merchandise/contracts/records';
import { MarketSettingsSchema } from '@app/merchandise/domain/market-offers';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

import { MarketDefinitionSchema } from '../../shared/market-contracts.ts';
import { PriceListEditor } from '../../src/market-admin/assortment-section.tsx';
import type { ExceptionsSpec } from '../../src/market-admin/assortment-section.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('@app/merchandise/clients/manage-markets');
rstest.mock('@app/merchandise/clients/records');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
// Leaving with unsaved input is asked for while the router reports the navigation blocked.
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: (options: { readonly shouldBlockFn: () => boolean }) => ({
    proceed: constVoid,
    reset: constVoid,
    status: options.shouldBlockFn() ? 'blocked' : 'idle',
  }),
}));

const legalEntityId = '33333333-3333-4333-8333-333333333333';
const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '30000000-0000-4000-8000-000000000001';

const settings = Schema.decodeUnknownSync(MarketSettingsSchema)({
  currency: 'CZK',
  exceptionCounts: { notOffered: 0, offered: 0 },
  exchangeRate: '1',
  marketCode: 'CZ-B2C',
  marketId,
  offerMode: 'WHOLE_CATALOGUE',
  revision: 3,
  roundingMinor: 1,
  updatedAt: '2026-11-01T10:00:00.000Z',
});

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
    resourceId: legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  supportedLocales: ['cs-CZ'],
});

/** Two products that are exceptions of a whole-catalogue market, both offered as the page shows them. */
const exceptionItems = [
  { name: 'Šroub A', offered: true, productId: 'p-1', sku: 'SKU-1' },
  { name: 'Šroub B', offered: true, productId: 'p-2', sku: 'SKU-2' },
];

const exceptions: ExceptionsSpec = {
  input: { legalEntityId, marketId, offset: 0, tenantId },
  offeredByDefault: true,
  onOffset: constVoid,
};

const commands = () => rstest.mocked(executeManageMarkets).mock.calls.length;
const commandTags = (): string[] =>
  rstest.mocked(executeManageMarkets).mock.calls.map(([payload]) => payload.command._tag);

const settle = async (): Promise<void> => {
  await act(async () => {
    await browserRuntime.runPromise(Effect.yieldNow);
  });
};

const mounted: { container: HTMLElement; root: Root }[] = [];

const mount = async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(
      <PriceListEditor
        canManage
        exceptions={exceptions}
        market={market}
        onAwaitingApproval={constVoid}
        refresh={Effect.void}
        revision={3}
        settings={settings}
      />,
    );
  });
  await settle();
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const saveButton = (): HTMLButtonElement => {
  const [found] = buttons('Uložit');
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

/** The hidden checkbox of one product's switch: a click on it is a click on the switch. */
const switchFor = (sku: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[name="market-offer-${sku}"]`)));

const toggle = async (sku: string) => {
  await act(async () => {
    switchFor(sku).click();
  });
  await settle();
};

const clickSave = async () => {
  await act(async () => {
    saveButton().click();
  });
  await settle();
};

beforeEach(() => {
  rstest.mocked(executeManageMarkets).mockReset();
  rstest.mocked(executeManageMarkets).mockReturnValue(Effect.succeed({ entityIds: [], revision: 9 }));
  rstest.mocked(executeRecords).mockReturnValue(
    Effect.succeed(
      Schema.decodeUnknownSync(RecordsResponseSchema)({
        actorPrincipalRef: { principalId: '20000000-0000-4000-8000-000000000002', tenantId },
        canWrite: true,
        indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 0, stockValueMinor: 0 },
        marketExceptions: { items: exceptionItems, marketId, total: 2 },
        movements: [],
        orders: [],
        products: [],
        revision: 3,
      }),
    ),
  );
});

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

describe('e-shop offer switches of the price list', () => {
  it.live('toggling writes nothing; Save sends the changed offer once', () =>
    Effect.gen(function* toggleSendsNothing() {
      yield* Effect.promise(() => mount());
      yield* Effect.sleep('50 millis');
      yield* Effect.promise(settle);
      yield* Effect.promise(() => toggle('SKU-1'));
      yield* Effect.sleep('1 second');
      yield* Effect.promise(settle);
      expect(commands()).toBe(0);
      expect(saveButton().disabled).toBe(false);

      yield* Effect.promise(() => clickSave());
      yield* Effect.sleep('100 millis');
      yield* Effect.promise(settle);
      expect(commands()).toBe(1);
      expect(commandTags()).toEqual(['SetProductMarketOffer']);
    }),
  );

  it.live('Save sends each of two changed offers exactly once', () =>
    Effect.gen(function* twoOffers() {
      yield* Effect.promise(() => mount());
      yield* Effect.sleep('50 millis');
      yield* Effect.promise(settle);
      yield* Effect.promise(() => toggle('SKU-1'));
      yield* Effect.promise(() => toggle('SKU-2'));
      expect(commands()).toBe(0);

      yield* Effect.promise(() => clickSave());
      yield* Effect.sleep('100 millis');
      yield* Effect.promise(settle);
      expect(commands()).toBe(2);
      expect(commandTags()).toEqual(['SetProductMarketOffer', 'SetProductMarketOffer']);
    }),
  );

  it.live('leaving with unsaved offers asks first', () =>
    Effect.gen(function* offersLeaveAsks() {
      yield* Effect.promise(() => mount());
      yield* Effect.sleep('50 millis');
      yield* Effect.promise(settle);
      yield* Effect.promise(() => toggle('SKU-1'));
      yield* Effect.promise(settle);
      expect(buttons('Zůstat').length).toBeGreaterThan(0);
      expect(buttons('Zahodit změny').length).toBeGreaterThan(0);
      expect(commands()).toBe(0);
    }),
  );
});
