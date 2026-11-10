// @rstest-environment happy-dom
// The market dialogs with a form: typing changes only the dialog's draft, the one Save sends once, and leaving with
// unsaved input asks first. Only the Market Action clients, the i18n runtime and the router blocker are replaced.
import { executeManageMarkets } from '@app/merchandise/clients/manage-markets';
import { StorefrontApplicationSummarySchema } from '@app/storefront-registry/api/storefront-applications';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

import { AssociateStorefrontResultSchema } from '../../shared/actions/associate-storefront.ts';
import { CreateMarketResultSchema } from '../../shared/actions/create-market.ts';
import { ReviseMarketDefinitionResultSchema } from '../../shared/actions/revise-market-definition.ts';
import { MarketDefinitionSchema } from '../../shared/market-contracts.ts';
import { executeAssociateStorefront } from '../../src/api/associate-storefront-action-client.ts';
import { executeCreateMarket } from '../../src/api/create-market-action-client.ts';
import { executeReviseMarketDefinition } from '../../src/api/revise-market-definition-action-client.ts';
import { EditMarketDialog } from '../../src/market-admin/market-dialogs.tsx';
import { NewMarketDialog } from '../../src/market-admin/new-market-dialog.tsx';
import { StorefrontsSection } from '../../src/market-admin/storefronts-section.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/associate-storefront-action-client.ts');
rstest.mock('../../src/api/create-market-action-client.ts');
rstest.mock('../../src/api/revise-market-definition-action-client.ts');
rstest.mock('@app/merchandise/clients/manage-markets');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
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

const revised = Schema.decodeUnknownSync(ReviseMarketDefinitionResultSchema)({
  definitionRevisionRef: { ...market.definitionRevisionRef, resourceId: '77777777-7777-4777-8777-777777777777' },
  marketRef: market.marketRef,
  previousDefinitionRevisionRef: market.definitionRevisionRef,
  revision: 2,
});

const created = Schema.decodeUnknownSync(CreateMarketResultSchema)({
  created: true,
  definitionRevisionRef: market.definitionRevisionRef,
  marketRef: market.marketRef,
  revision: 1,
});

const associated = Schema.decodeUnknownSync(AssociateStorefrontResultSchema)({
  associationRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '88888888-8888-4888-8888-888888888888',
    resourceType: 'commerce.market-catalog.storefront-association',
    tenantId,
  },
  changed: true,
  marketRef: market.marketRef,
  revision: 1,
});

const storefront = Schema.decodeUnknownSync(StorefrontApplicationSummarySchema)({
  allowedChannels: ['B2C'],
  effectiveInterval: { effectiveFrom: '2026-01-01T00:00:00.000Z' },
  lifecycle: 'ACTIVE',
  revision: 1,
  storefrontAppId: 'shop-b2c',
  storefrontApplicationRef: {
    moduleId: 'commerce.storefront-registry',
    resourceId: '77777777-7777-4777-8777-777777777771',
    resourceType: 'commerce.storefront-registry.storefront-application',
    tenantId,
  },
});

const writes = (mock: { mock: { calls: unknown[] } }) => mock.mock.calls.length;

const settle = async (): Promise<void> => {
  await act(async () => {
    await browserRuntime.runPromise(Effect.yieldNow);
  });
};

const mounted: { container: HTMLElement; root: Root }[] = [];

const mountTree = async (element: ReactElement) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(element);
  });
  await settle();
};

/** The mocked i18n returns the key; the vertical's keys are prefixed with its namespace. */
const keyOf = (path: string) => `commerce-market-catalog.${path}`;

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const buttonNamed = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

const fieldById = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));

/** Types like a user: React sees a native input event. */
const typeInto = async (id: string, value: string) => {
  await act(async () => {
    const field = fieldById(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};

const clickButton = async (name: string) => {
  await act(async () => {
    buttonNamed(name).click();
  });
  await settle();
};

const isOpen = (text: string) => buttons(text).length > 0;

beforeEach(() => {
  rstest.mocked(executeReviseMarketDefinition).mockReset();
  rstest.mocked(executeCreateMarket).mockReset();
  rstest.mocked(executeAssociateStorefront).mockReset();
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

describe('edit market dialog', () => {
  it.live('typing changes only the draft; Save revises the market once and reports it', () =>
    Effect.gen(function* editTypingSendsNothing() {
      rstest.mocked(executeReviseMarketDefinition).mockReturnValue(Effect.succeed(revised));
      const onDone = rstest.fn(constVoid);
      yield* Effect.promise(() =>
        mountTree(
          <EditMarketDialog market={market} onAwaitingApproval={constVoid} onClose={constVoid} onDone={onDone} />,
        ),
      );
      yield* Effect.promise(() => typeInto('edit-market-purpose', 'Nový účel'));
      yield* Effect.sleep('1 second');
      expect(writes(rstest.mocked(executeReviseMarketDefinition))).toBe(0);
      expect(buttonNamed('Uložit').disabled).toBe(true);

      yield* Effect.promise(() => typeInto('edit-market-reason', 'Oprava názvu'));
      expect(buttonNamed('Uložit').disabled).toBe(false);
      expect(writes(rstest.mocked(executeReviseMarketDefinition))).toBe(0);

      yield* Effect.promise(() => clickButton('Uložit'));
      expect(writes(rstest.mocked(executeReviseMarketDefinition))).toBe(1);
      expect(onDone).toHaveBeenCalledTimes(1);
    }),
  );

  it.live('leaving with unsaved input asks first and sends nothing', () =>
    Effect.gen(function* editLeaveAsks() {
      const onClose = rstest.fn(constVoid);
      yield* Effect.promise(() =>
        mountTree(
          <EditMarketDialog market={market} onAwaitingApproval={constVoid} onClose={onClose} onDone={constVoid} />,
        ),
      );
      yield* Effect.promise(() => typeInto('edit-market-purpose', 'Nový účel'));
      yield* Effect.promise(() => clickButton(keyOf('form.cancel')));
      expect(isOpen('Zůstat')).toBe(true);
      expect(isOpen('Zahodit změny')).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
      expect(writes(rstest.mocked(executeReviseMarketDefinition))).toBe(0);

      yield* Effect.promise(() => clickButton('Zůstat'));
      expect(onClose).not.toHaveBeenCalled();
    }),
  );
});

describe('new market dialog', () => {
  it.live('typing changes only the draft; Save creates the market once', () =>
    Effect.gen(function* newMarketTypingSendsNothing() {
      rstest.mocked(executeCreateMarket).mockReturnValue(Effect.succeed(created));
      const onCreated = rstest.fn(constVoid);
      yield* Effect.promise(() =>
        mountTree(
          <NewMarketDialog
            canConfigurePricing={false}
            legalEntityId="33333333-3333-4333-8333-333333333333"
            merchandiseRevision={3}
            onClose={constVoid}
            onCreated={onCreated}
            tenantId={tenantId}
          />,
        ),
      );
      yield* Effect.promise(() => typeInto('new-market-code', 'NEW_TRH'));
      yield* Effect.promise(() => typeInto('new-market-purpose', 'Nový trh'));
      yield* Effect.promise(() => typeInto('new-market-jurisdictions', 'CZ'));
      yield* Effect.promise(() => typeInto('new-market-locales', 'cs-CZ'));
      yield* Effect.promise(() => typeInto('new-market-valid-from', '2026-11-10'));
      yield* Effect.sleep('1 second');
      expect(writes(rstest.mocked(executeCreateMarket))).toBe(0);
      expect(buttonNamed('Uložit').disabled).toBe(false);

      yield* Effect.promise(() => clickButton('Uložit'));
      expect(writes(rstest.mocked(executeCreateMarket))).toBe(1);
      expect(onCreated).toHaveBeenCalledTimes(1);
    }),
  );

  it.live('leaving with unsaved input asks first', () =>
    Effect.gen(function* newMarketLeaveAsks() {
      const onClose = rstest.fn(constVoid);
      yield* Effect.promise(() =>
        mountTree(
          <NewMarketDialog
            canConfigurePricing={false}
            legalEntityId="33333333-3333-4333-8333-333333333333"
            merchandiseRevision={3}
            onClose={onClose}
            onCreated={constVoid}
            tenantId={tenantId}
          />,
        ),
      );
      yield* Effect.promise(() => typeInto('new-market-code', 'NEW_TRH'));
      yield* Effect.promise(() => clickButton(keyOf('form.cancel')));
      expect(isOpen('Zůstat')).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
      expect(writes(rstest.mocked(executeCreateMarket))).toBe(0);
    }),
  );
});

const section = (onDone: (message: string) => void) => (
  <StorefrontsSection
    associations={[]}
    canAdminister
    market={market}
    onAwaitingApproval={constVoid}
    onDone={onDone}
    storefronts={[storefront]}
  />
);

describe('storefront association dialog', () => {
  it.live('typing changes only the draft; Save associates the e-shop once', () =>
    Effect.gen(function* associationTypingSendsNothing() {
      rstest.mocked(executeAssociateStorefront).mockReturnValue(Effect.succeed(associated));
      const onDone = rstest.fn(constVoid);
      yield* Effect.promise(() => mountTree(section(onDone)));
      yield* Effect.promise(() => clickButton(keyOf('detail.storefronts.associate')));
      yield* Effect.promise(() => typeInto('association-valid-from', '2026-11-10'));
      yield* Effect.sleep('1 second');
      expect(writes(rstest.mocked(executeAssociateStorefront))).toBe(0);

      yield* Effect.promise(() => clickButton('Uložit'));
      expect(writes(rstest.mocked(executeAssociateStorefront))).toBe(1);
      expect(onDone).toHaveBeenCalledTimes(1);
    }),
  );

  it.live('the pre-selected e-shop saves without typing; leaving untouched asks nothing', () =>
    Effect.gen(function* associationDefaultsSave() {
      rstest.mocked(executeAssociateStorefront).mockReturnValue(Effect.succeed(associated));
      yield* Effect.promise(() => mountTree(section(constVoid)));
      yield* Effect.promise(() => clickButton(keyOf('detail.storefronts.associate')));
      expect(buttonNamed('Uložit').disabled).toBe(false);
      yield* Effect.promise(() => clickButton(keyOf('form.cancel')));
      expect(isOpen('Zůstat')).toBe(false);

      yield* Effect.promise(() => clickButton(keyOf('detail.storefronts.associate')));
      yield* Effect.promise(() => clickButton('Uložit'));
      expect(writes(rstest.mocked(executeAssociateStorefront))).toBe(1);
    }),
  );

  it.live('leaving with unsaved input asks first', () =>
    Effect.gen(function* associationLeaveAsks() {
      yield* Effect.promise(() => mountTree(section(constVoid)));
      yield* Effect.promise(() => clickButton(keyOf('detail.storefronts.associate')));
      yield* Effect.promise(() => typeInto('association-valid-from', '2026-11-10'));
      yield* Effect.promise(() => clickButton(keyOf('form.cancel')));
      expect(isOpen('Zůstat')).toBe(true);
      expect(writes(rstest.mocked(executeAssociateStorefront))).toBe(0);
    }),
  );
});
