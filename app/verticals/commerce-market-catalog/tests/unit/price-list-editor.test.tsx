// @rstest-environment happy-dom
// The price list of a market as the user sees it: edits change only the draft, one Save button sends one
// ConfigureMarket, and a change parked for approval stays unsaved. Only the merchandise client, the i18n runtime and
// the router blocker are replaced.
import { executeManageMarkets } from '@app/merchandise/apis/manage-markets-action/client';
import { MarketSettingsSchema } from '@app/merchandise/domain/market-offers';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

import { MarketDefinitionSchema } from '../../shared/market-contracts.ts';
import { PriceListEditor } from '../../src/market-admin/assortment-section.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('@app/merchandise/apis/manage-markets-action/client');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));

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
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  supportedLocales: ['cs-CZ'],
});

const commands = () => rstest.mocked(executeManageMarkets).mock.calls.length;

const settle = async (): Promise<void> => {
  await act(async () => {
    await browserRuntime.runPromise(Effect.yieldNow);
  });
};

const mounted: { container: HTMLElement; root: Root }[] = [];

const mount = async (onAwaitingApproval: () => void = constVoid) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(
      <PriceListEditor
        canManage
        market={market}
        onAwaitingApproval={onAwaitingApproval}
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

const rateField = (): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[id="market-pricing-rate"]')));

/** Types like a user: React sees a native input event. */
const typeRate = async (value: string) => {
  await act(async () => {
    const field = rateField();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};

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

describe('price list editor', () => {
  it.live('typing changes only the draft: nothing is sent while the user types or waits', () =>
    Effect.gen(function* typingSendsNothing() {
      rstest
        .mocked(executeManageMarkets)
        .mockReturnValue(Effect.succeed({ entityIds: [], marketRevision: 4, revision: 9 }));
      yield* Effect.promise(() => mount());
      expect(saveButton().disabled).toBe(true);

      yield* Effect.promise(() => typeRate('24,5'));
      expect(saveButton().disabled).toBe(false);
      yield* Effect.sleep('1 second');
      yield* Effect.promise(settle);
      expect(commands()).toBe(0);
    }),
  );

  it.live('one click on Uložit sends exactly one ConfigureMarket', () =>
    Effect.gen(function* oneSave() {
      rstest
        .mocked(executeManageMarkets)
        .mockReturnValue(Effect.succeed({ entityIds: [], marketRevision: 4, revision: 9 }));
      yield* Effect.promise(() => mount());
      yield* Effect.promise(() => typeRate('24,5'));
      yield* Effect.promise(() =>
        act(async () => {
          saveButton().click();
        }),
      );
      yield* Effect.promise(settle);
      yield* Effect.sleep('100 millis');
      yield* Effect.promise(settle);
      expect(commands()).toBe(1);
    }),
  );

  it.live('a change parked for approval is not sent again and asks the screen to say so', () =>
    Effect.gen(function* parked() {
      let awaiting = 0;
      const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
        _tag: 'ActionProposalAccepted',
        expiresAt: '2026-11-14T10:00:00.000Z',
        proposalId: '77777777-7777-4777-8777-777777777777',
      });
      rstest.mocked(executeManageMarkets).mockReturnValue(Effect.succeed(proposal));
      yield* Effect.promise(() =>
        mount(() => {
          awaiting += 1;
        }),
      );
      yield* Effect.promise(() => typeRate('24,5'));
      yield* Effect.promise(() =>
        act(async () => {
          saveButton().click();
        }),
      );
      yield* Effect.sleep('100 millis');
      yield* Effect.promise(settle);
      expect(commands()).toBe(1);
      expect(awaiting).toBe(1);
    }),
  );
});
