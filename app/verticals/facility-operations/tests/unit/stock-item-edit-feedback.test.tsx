// @rstest-environment happy-dom
// The stock item edit says how its save ended, as it did before the shared Save: a saved item shows the "saved"
// toast, and a refused save names the agenda's reason instead of the general failure text.
import { Effect, Predicate, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { PurchasingStateSchema, emptyPurchasingState } from '../../shared/domain/purchasing.ts';
import type { PurchasingState } from '../../shared/domain/purchasing.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import { ItemPanel } from '../../src/routes/[lang]/provoz/nakupy/stock-tab.tsx';
import type { CommandOutcome } from '../../src/ui/use-agenda.ts';
import { bodyText, click, labels, mountPanel, toPage, typeInto, unmountPanels } from './draft-base-fixture.ts';

/** What a toast says, as the panel creates it. */
interface Toast {
  readonly title?: string | undefined;
  readonly type?: string | undefined;
}

const { toasts } = rstest.hoisted(() => {
  const created: Toast[] = [];
  return { toasts: created };
});

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
// The toasts the panel creates are recorded; the page's toaster is not rendered here.
rstest.mock('@techsio/ui-kit/molecules/toast', () => ({
  Toaster: () => null,
  toaster: { attrs: {} },
  useToast: () => ({
    create: (toast: { readonly title?: string; readonly type?: string }) => {
      toasts.push({ title: toast.title, type: toast.type });
    },
  }),
}));

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const audit = {
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
};
const state: PurchasingState = Schema.decodeUnknownSync(PurchasingStateSchema)({
  ...emptyPurchasingState,
  items: [
    {
      ...audit,
      category: 'consumable',
      id: 'item-1',
      leadTimeDays: 7,
      maximum: 50,
      minimum: 10,
      name: 'Filtr G4',
      sku: 'FLT-G4',
      tracking: 'none',
      unit: 'ks',
      warehouseId: 'warehouse-1',
    },
  ],
  warehouses: [{ ...audit, code: 'HS', id: 'warehouse-1', name: 'Hlavní sklad' }],
});

const answering =
  (sent: OpsCommand[], outcome: CommandOutcome) =>
  (command: OpsCommand): Effect.Effect<CommandOutcome> =>
    Effect.sync(() => {
      sent.push(command);
      return outcome;
    });

const editName = Effect.fnUntraced(function* editName(run: (command: OpsCommand) => Effect.Effect<CommandOutcome>) {
  yield* mountPanel(
    createElement(ItemPanel, {
      canWrite: true,
      itemId: 'item-1',
      me: actor,
      onClose: toPage,
      onOpenOrder: toPage,
      run,
      state,
    }),
  );
  yield* click('facility-operations.purchasing.actions.edit');
  yield* typeInto('#item-edit-name', 'Filtr G4 kapsový');
  yield* click(labels.save);
});

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  toasts.length = 0;
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

describe('stock item edit', () => {
  it.live('a saved item shows the saved toast', () =>
    Effect.gen(function* saved() {
      const sent: OpsCommand[] = [];
      yield* editName(answering(sent, { ok: true, result: { entityIds: [], revision: 4 } }));
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'StockItemUpdate')).toBe(true);
      expect(toasts).toEqual([{ title: 'facility-operations.common.saved', type: 'success' }]);
    }),
  );

  it.live('a refused save names the reason', () =>
    Effect.gen(function* refused() {
      const sent: OpsCommand[] = [];
      yield* editName(answering(sent, { ok: false, reason: 'forbidden' }));
      expect(sent).toHaveLength(1);
      expect(bodyText()).toContain('facility-operations.common.errors.forbidden');
      expect(bodyText()).not.toContain(labels.failed);
      expect(toasts).toEqual([]);
    }),
  );
});
