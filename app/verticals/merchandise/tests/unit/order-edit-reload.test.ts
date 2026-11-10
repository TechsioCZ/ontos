// @rstest-environment happy-dom
// Mounted order edit draft: the real `useOrderEditAutosave` the edit form uses, with the real autosave controller,
// command builder and `editOrder`. Only the two generated clients are replaced. The order detail keeps the form
// mounted while its order reloads, so these prove what the draft does when the reloaded order arrives.
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { DateTime, Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ManageCatalogActionConflictProblemSchema } from '../../shared/apis/manage-catalog-action.ts';
import { OrderSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { Order } from '../../shared/apis/records.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { useOrderEditAutosave } from '../../src/routes/[lang]/prodej/objednavky/order-edit-autosave.ts';
import type { Draft } from '../../src/routes/[lang]/prodej/objednavky/order-edit-draft.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('../../src/api/cleanup-demo-action-client.ts');
rstest.mock('../../src/api/change-order-status-action-client.ts');

const opened = '2026-10-15T10:00:00.000Z';
const changedElsewhere = '2026-10-15T10:05:00.000Z';
const savedHere = '2026-10-15T10:06:00.000Z';

const orderOf = (fields: { readonly note?: string; readonly quantity?: number; readonly updatedAt: string }): Order =>
  Schema.decodeSync(OrderSchema)({
    contact: { email: 'ada@example.test', name: 'Ada Guest' },
    createdAt: opened,
    deliveryAddress: { city: 'Brno', country: 'CZ', postalCode: '60200', street: 'Kavárna 1' },
    demo: true,
    id: 'order-1',
    lines: [
      {
        productId: 'product-1',
        productName: 'Cable',
        quantity: fields.quantity ?? 2,
        sku: 'CABLE',
        unitPriceMinor: 100,
        vatRate: 21,
      },
    ],
    note: fields.note ?? '',
    number: 'ORD-1',
    partyId: 'party-1',
    status: 'NEW',
    totalMinor: 200,
    totalVatMinor: 42,
    updatedAt: fields.updatedAt,
  });

const recordsWith = (order: Order, revision: number) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 200, orderCount: 1, productCount: 1, stockValueMinor: 1000 },
    movements: [],
    orders: [Schema.encodeSync(OrderSchema)(order)],
    products: [],
    revision,
  });

/** What the server received: the edit and both versions it named. */
const sentEdits = () =>
  rstest.mocked(executeManageCatalog).mock.calls.map(([payload]) => {
    const { command } = payload;
    return {
      command,
      expectedRevision: payload.expectedRevision,
      expectedUpdatedAt:
        command._tag === 'EditOrder' && command.expectedUpdatedAt !== undefined
          ? DateTime.formatIso(command.expectedUpdatedAt)
          : undefined,
    };
  });

/** The server accepts the next edit and then has `after` at `revision`, which the form reads back. */
const acceptNextEdit = (after: Order, revision: number) => {
  rstest.mocked(executeManageCatalog).mockReturnValueOnce(Effect.succeed({ entityIds: [], revision }));
  rstest.mocked(executeRecords).mockReturnValue(Effect.succeed(recordsWith(after, revision)));
};

type OrderEdit = ReturnType<typeof useOrderEditAutosave>;

let latest: OrderEdit | null = null;
const edit = (): OrderEdit => Option.getOrThrow(Option.fromNullOr(latest));
const draft = (): Draft => edit().autosave.draft;

const Harness = ({ order, revision }: { readonly order: Order; readonly revision: number }) => {
  const value = useOrderEditAutosave({ isValid: () => true, order, revision });
  useEffect(() => {
    latest = value;
  }, [value]);
  return null;
};

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

interface Mounted {
  /** The order detail hands the mounted form another read of the same order. */
  readonly reload: (order: Order, revision: number) => Effect.Effect<void>;
  readonly unmount: () => void;
}

const mounted: Mounted[] = [];

const mount = async (order: Order, revision: number): Promise<Mounted> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const show = async (nextOrder: Order, nextRevision: number) => {
    await act(async () => {
      root.render(createElement(Harness, { order: nextOrder, revision: nextRevision }));
      await settle();
    });
  };
  let live = true;
  const view: Mounted = {
    reload: (nextOrder, nextRevision) => Effect.promise(() => show(nextOrder, nextRevision)),
    unmount: () => {
      if (live) {
        live = false;
        act(() => {
          root.unmount();
          container.remove();
        });
      }
    },
  };
  mounted.push(view);
  await show(order, revision);
  return view;
};

const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition() || attempt >= 400) {
    expect(condition()).toBe(true);
    return;
  }
  await act(settle);
  await waitUntil(condition, attempt + 1);
};

const type = (patch: Partial<Draft>) =>
  Effect.promise(() =>
    act(async () => {
      edit().autosave.setDraft((current) => ({ ...current, ...patch }));
      await settle();
    }),
  );

/** Blur: the pending change is sent now. Resolves once that many edits reached the server and the save settled. */
const saveNow = (sent: number) =>
  Effect.promise(async () => {
    await act(async () => {
      edit().autosave.flush();
      await settle();
    });
    await waitUntil(() => sentEdits().length === sent && edit().autosave.status !== 'saving');
  });

const quantityOf = (value: Draft): string | undefined => value.lines[0]?.quantityText;

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  latest = null;
});

afterEach(() => {
  for (const view of mounted) {
    view.unmount();
  }
  mounted.length = 0;
  rstest.unstubAllGlobals();
});

describe('mounted order edit draft against a reloaded order', () => {
  it.effect('an untouched draft takes the reloaded order, so a later edit builds on the other change', () =>
    Effect.gen(function* clean() {
      const view = yield* Effect.promise(() => mount(orderOf({ updatedAt: opened }), 7));
      const theirs = orderOf({ quantity: 5, updatedAt: changedElsewhere });

      yield* view.reload(theirs, 8);
      expect(quantityOf(draft())).toBe('5');
      expect(edit().autosave.status).toBe('idle');

      acceptNextEdit(orderOf({ note: 'Zavolat předem', quantity: 5, updatedAt: savedHere }), 9);
      yield* type({ note: 'Zavolat předem' });
      yield* saveNow(1);

      // Only the note travels, against the version that already carries their quantity.
      expect(sentEdits()).toEqual([
        {
          command: {
            _tag: 'EditOrder',
            expectedUpdatedAt: theirs.updatedAt,
            id: 'order-1',
            note: 'Zavolat předem',
          },
          expectedRevision: 8,
          expectedUpdatedAt: changedElsewhere,
        },
      ]);
      expect(edit().autosave.status).toBe('saved');
    }),
  );

  it.effect('a changed draft keeps its typed values and saves against the order version it was typed over', () =>
    Effect.gen(function* dirty() {
      const mine = orderOf({ updatedAt: opened });
      const view = yield* Effect.promise(() => mount(mine, 7));
      yield* type({ note: 'Zavolat předem' });

      // Someone else changes the quantity; the held detail hands the mounted form their version.
      yield* view.reload(orderOf({ quantity: 5, updatedAt: changedElsewhere }), 8);
      expect(draft().note).toBe('Zavolat předem');
      expect(quantityOf(draft())).toBe('2');

      const conflict = yield* Schema.decodeEffect(ManageCatalogActionConflictProblemSchema)({
        _tag: 'ManageCatalogActionConflictProblem',
        code: 'merchandise_revision_conflict',
        detail: 'The order changed; refresh before another edit',
        status: 409,
        title: 'Conflict',
        type: 'urn:test:conflict',
      });
      rstest.mocked(executeManageCatalog).mockReturnValueOnce(Effect.fail(conflict));
      yield* saveNow(1);

      // The edit names the opened version, so the server refuses it; the old quantity is not sent over theirs.
      expect(sentEdits()).toEqual([
        {
          command: {
            _tag: 'EditOrder',
            expectedUpdatedAt: mine.updatedAt,
            id: 'order-1',
            note: 'Zavolat předem',
          },
          expectedRevision: 7,
          expectedUpdatedAt: opened,
        },
      ]);
      expect(edit().autosave.status).toBe('conflict');
      expect(draft().note).toBe('Zavolat předem');
    }),
  );

  it.effect('the next change builds on the form own save while the order on the page is still the old one', () =>
    Effect.gen(function* ownSave() {
      const before = orderOf({ updatedAt: opened });
      yield* Effect.promise(() => mount(before, 7));
      acceptNextEdit(orderOf({ note: 'Zavolat předem', updatedAt: savedHere }), 8);
      yield* type({ note: 'Zavolat předem' });
      yield* saveNow(1);
      expect(edit().autosave.status).toBe('saved');

      // The reload after that save has not landed: the page still shows the order without the note.
      acceptNextEdit(orderOf({ updatedAt: '2026-10-15T10:07:00.000Z' }), 9);
      yield* type({ note: '' });
      yield* saveNow(2);

      // Taking the note back is a change of what was saved, against the version that save left behind.
      expect(sentEdits()[1]).toEqual({
        command: {
          _tag: 'EditOrder',
          expectedUpdatedAt: DateTime.makeUnsafe(savedHere),
          id: 'order-1',
          note: '',
        },
        expectedRevision: 8,
        expectedUpdatedAt: savedHere,
      });
      expect(edit().autosave.status).toBe('saved');
    }),
  );

  it.effect('a save that went through clears the approval notice of an earlier refused save', () =>
    Effect.gen(function* approvalNotice() {
      yield* Effect.promise(() => mount(orderOf({ updatedAt: opened }), 7));
      const receipt = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
        _tag: 'ActionProposalAccepted',
        expiresAt: '2026-11-10T12:00:00.000Z',
        proposalId: '60000000-0000-4000-8000-000000000001',
      });
      rstest.mocked(executeManageCatalog).mockReturnValueOnce(Effect.succeed(receipt));
      yield* type({ note: 'Zavolat předem' });
      yield* saveNow(1);
      expect(edit().autosave.status).toBe('error');
      expect(edit().pendingMessage).not.toBeNull();

      acceptNextEdit(orderOf({ note: 'Zavolat předem', updatedAt: savedHere }), 8);
      yield* Effect.promise(() =>
        act(async () => {
          edit().autosave.retry();
          await settle();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => edit().autosave.status === 'saved'));
      expect(edit().pendingMessage).toBeNull();
    }),
  );
});
