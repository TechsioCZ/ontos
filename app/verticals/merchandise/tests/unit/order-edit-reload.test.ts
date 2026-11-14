// @rstest-environment happy-dom
// Mounted order edit draft: the real `useOrderEditDraft` the edit form uses, with the real draft controller,
// command builder and `editOrder`. Only the two generated clients are replaced. The order detail keeps the form
// mounted while its order reloads, so these prove what the draft does when the reloaded order arrives.
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { DateTime, Effect, Option, Predicate, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ManageCatalogActionConflictProblemSchema } from '../../shared/apis/manage-catalog-action.ts';
import { OrderSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { Order } from '../../shared/apis/records.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { useOrderEditDraft } from '../../src/routes/[lang]/prodej/objednavky/order-edit-save.ts';
import { addressIncomplete, contactIncomplete } from '../../src/routes/[lang]/prodej/objednavky/order-edit-draft.ts';
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

/** The same order before it had a delivery address. */
const withoutAddress = (order: Order): Order => {
  const encoded = { ...Schema.encodeSync(OrderSchema)(order) };
  Reflect.deleteProperty(encoded, 'deliveryAddress');
  return Schema.decodeSync(OrderSchema)(encoded);
};

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
        Predicate.isTagged(command, 'EditOrder') && command.expectedUpdatedAt !== undefined
          ? DateTime.formatIso(command.expectedUpdatedAt)
          : undefined,
    };
  });

/** The server accepts the next edit and then has `after` at `revision`, which the form reads back. */
const acceptNextEdit = (after: Order, revision: number) => {
  rstest.mocked(executeManageCatalog).mockReturnValueOnce(Effect.succeed({ entityIds: [], revision }));
  rstest.mocked(executeRecords).mockReturnValue(Effect.succeed(recordsWith(after, revision)));
};

const refused = Schema.decodeSync(ManageCatalogActionConflictProblemSchema)({
  _tag: 'ManageCatalogActionConflictProblem',
  code: 'merchandise_revision_conflict',
  detail: 'The order changed; refresh before another edit',
  status: 409,
  title: 'Conflict',
  type: 'urn:test:conflict',
});

/**
 * A register that checks an edit the way the server does: the edit must name the version of the order the register
 * has. `afterEdits` are the orders the register has after each accepted edit, in turn; one that carries more than
 * the edit wrote stands for someone else's change that landed right behind it.
 */
const serveLikeTheRegister = (start: Order, startRevision: number, afterEdits: readonly Order[]) => {
  const register = { accepted: 0, order: start, revision: startRevision };
  rstest
    .mocked(executeRecords)
    .mockImplementation(() => Effect.sync(() => recordsWith(register.order, register.revision)));
  rstest.mocked(executeManageCatalog).mockImplementation(({ command }) =>
    Effect.suspend(() => {
      const next = afterEdits[register.accepted];
      const named = Predicate.isTagged(command, 'EditOrder') ? command.expectedUpdatedAt : undefined;
      if (
        next === undefined ||
        named === undefined ||
        DateTime.toEpochMillis(named) !== DateTime.toEpochMillis(register.order.updatedAt)
      ) {
        return Effect.fail(refused);
      }
      register.accepted += 1;
      register.order = next;
      register.revision += 1;
      return Effect.succeed({ entityIds: [], revision: register.revision });
    }),
  );
  return register;
};

type OrderEdit = ReturnType<typeof useOrderEditDraft>;

let latest: OrderEdit | null = null;
const edit = (): OrderEdit => Option.getOrThrow(Option.fromNullOr(latest));
const draft = (): Draft => edit().record.draft;

type DraftRule = (value: Draft, confirmed: Draft) => boolean;
const anyDraft: DraftRule = () => true;
/** The form's rule for the parts an edit sends whole: an edited address or contact has to be complete. */
const completeDetails: DraftRule = (value, confirmed) =>
  !addressIncomplete(value, confirmed) && !contactIncomplete(value, confirmed);

interface HarnessProps {
  readonly isValid: DraftRule;
  readonly order: Order;
  readonly revision: number;
}

const Harness = ({ isValid, order, revision }: HarnessProps) => {
  const value = useOrderEditDraft({
    isValid,
    onOfferedPriceChanged: () => Effect.void,
    onSaveSucceeded: constVoid,
    onSend: constVoid,
    order,
    revision,
  });
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

const mount = async (order: Order, revision: number, isValid: DraftRule = anyDraft): Promise<Mounted> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const show = async (nextOrder: Order, nextRevision: number) => {
    await act(async () => {
      root.render(createElement(Harness, { isValid, order: nextOrder, revision: nextRevision }));
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
      edit().record.setDraft((current) => ({ ...current, ...patch }));
      await settle();
    }),
  );

/** The Save button: the changed draft is sent now. Resolves once that many edits reached the server and the save settled. */
const saveNow = (sent: number) =>
  Effect.promise(async () => {
    await act(async () => {
      edit().record.save();
      await settle();
    });
    await waitUntil(() => sentEdits().length === sent && edit().record.status !== 'saving');
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
      expect(edit().record.status).toBe('idle');

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
      expect(edit().record.status).toBe('saved');
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
      expect(edit().record.status).toBe('conflict');
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
      expect(edit().record.status).toBe('saved');

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
      expect(edit().record.status).toBe('saved');
    }),
  );

  it.effect('a read-back that already carries someone else change does not become the base of the kept draft', () =>
    Effect.gen(function* raced() {
      const mine = orderOf({ updatedAt: opened });
      yield* Effect.promise(() => mount(mine, 7));
      // The note is saved, and before the form reads the order back someone else changes the quantity to 5.
      const register = serveLikeTheRegister(mine, 7, [
        orderOf({ note: 'Zavolat předem', quantity: 5, updatedAt: changedElsewhere }),
        orderOf({ note: 'Zavolat předem', quantity: 3, updatedAt: savedHere }),
      ]);
      yield* type({ note: 'Zavolat předem' });
      yield* saveNow(1);
      expect(edit().record.status).toBe('saved');

      // The draft still holds the quantity the form opened with; changing it sends all the lines.
      yield* type({ lines: draft().lines.map((line) => ({ ...line, quantityText: '3' })) });
      yield* saveNow(2);

      // The edit names the version the form saved over, so the register refuses it instead of taking 3 over their 5.
      expect(sentEdits()[1]?.expectedUpdatedAt).toBe(opened);
      expect(sentEdits()[1]?.expectedRevision).toBe(7);
      expect(edit().record.status).toBe('conflict');
      expect(register.order.lines[0]?.quantity).toBe(5);
    }),
  );

  it.effect('a read-back that differs only in what the form does not edit becomes the base', () =>
    Effect.gen(function* unrelated() {
      const mine = orderOf({ updatedAt: opened });
      yield* Effect.promise(() => mount(mine, 7));
      // Someone confirms the order right behind the save: a newer version with the same editable content.
      const confirmed = Schema.decodeSync(OrderSchema)({
        ...Schema.encodeSync(OrderSchema)(orderOf({ note: 'Zavolat předem', updatedAt: changedElsewhere })),
        status: 'CONFIRMED',
      });
      const register = serveLikeTheRegister(mine, 7, [
        confirmed,
        orderOf({ note: 'Zavolat předem', quantity: 3, updatedAt: savedHere }),
      ]);
      yield* type({ note: 'Zavolat předem' });
      yield* saveNow(1);

      yield* type({ lines: draft().lines.map((line) => ({ ...line, quantityText: '3' })) });
      yield* saveNow(2);
      expect(sentEdits()[1]?.expectedUpdatedAt).toBe(changedElsewhere);
      expect(sentEdits()[1]?.expectedRevision).toBe(8);
      expect(edit().record.status).toBe('saved');
      expect(register.order.lines[0]?.quantity).toBe(3);
    }),
  );

  it.effect('a typed change reason survives a reloaded order and goes out with the next edit', () =>
    Effect.gen(function* reasonKept() {
      const view = yield* Effect.promise(() => mount(orderOf({ updatedAt: opened }), 7));
      // A reason alone is no edit: nothing is sent, and the draft counts as saved.
      yield* type({ reason: 'Zákazník volal' });
      yield* saveNow(0);

      // Someone else changes the quantity: the draft takes their order and keeps the reason typed for the next edit.
      const theirs = orderOf({ quantity: 5, updatedAt: changedElsewhere });
      yield* view.reload(theirs, 8);
      expect(quantityOf(draft())).toBe('5');
      expect(draft().reason).toBe('Zákazník volal');

      const saved = orderOf({ note: 'Zavolat předem', quantity: 5, updatedAt: savedHere });
      acceptNextEdit(saved, 9);
      yield* type({ note: 'Zavolat předem' });
      yield* saveNow(1);
      expect(sentEdits()).toEqual([
        {
          command: {
            _tag: 'EditOrder',
            expectedUpdatedAt: theirs.updatedAt,
            id: 'order-1',
            note: 'Zavolat předem',
            reason: 'Zákazník volal',
          },
          expectedRevision: 8,
          expectedUpdatedAt: changedElsewhere,
        },
      ]);

      // The reason went into the history with that edit, so the reload after it clears the field.
      yield* view.reload(saved, 9);
      expect(draft().reason).toBe('');
      expect(draft().note).toBe('Zavolat předem');
    }),
  );

  it.effect('an address is checked against the saved one, not the one the page still shows', () =>
    Effect.gen(function* validationBase() {
      // The order has no delivery address yet; the form adds one and saves it.
      yield* Effect.promise(() => mount(withoutAddress(orderOf({ updatedAt: opened })), 7, completeDetails));
      acceptNextEdit(orderOf({ updatedAt: savedHere }), 8);
      yield* type({ city: 'Brno', country: 'CZ', postalCode: '60200', street: 'Kavárna 1' });
      yield* saveNow(1);
      expect(edit().record.status).toBe('saved');
      expect(sentEdits()[0]?.command).toMatchObject({
        deliveryAddress: { city: 'Brno', country: 'CZ', postalCode: '60200', street: 'Kavárna 1' },
      });

      // The reload has not landed: the page still shows the order without an address. Emptying the fields again
      // matches that order, but the edit would send the empty address over the saved one.
      yield* type({ city: '', country: '', postalCode: '', street: '' });
      yield* saveNow(1);
      expect(edit().record.status).toBe('invalid');
      expect(sentEdits()).toHaveLength(1);
      expect(addressIncomplete(draft(), edit().record.confirmed)).toBe(true);
    }),
  );

  it.effect('an edit parked for approval is held: Save does not send it again, a further edit is sent', () =>
    Effect.gen(function* approval() {
      yield* Effect.promise(() => mount(orderOf({ updatedAt: opened }), 7));
      const receipt = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
        _tag: 'ActionProposalAccepted',
        expiresAt: '2026-11-10T12:00:00.000Z',
        proposalId: '60000000-0000-4000-8000-000000000001',
      });
      rstest.mocked(executeManageCatalog).mockReturnValueOnce(Effect.succeed(receipt));
      yield* type({ note: 'Zavolat předem' });
      yield* saveNow(1);
      expect(edit().record.status).toBe('proposed');
      expect(edit().record.dirty).toBe(false);
      yield* saveNow(1);
      expect(sentEdits()).toHaveLength(1);

      acceptNextEdit(orderOf({ note: 'Zavolat předem, 2. patro', updatedAt: savedHere }), 8);
      yield* type({ note: 'Zavolat předem, 2. patro' });
      yield* saveNow(2);
      yield* Effect.promise(() => waitUntil(() => edit().record.status === 'saved'));
    }),
  );

  it.live('typing never sends an edit: not after any delay, not on unmount', () =>
    Effect.gen(function* noAutomaticSave() {
      const view = yield* Effect.promise(() => mount(orderOf({ updatedAt: opened }), 7));
      yield* type({ note: 'Zavolat předem' });
      expect(edit().record.status).toBe('dirty');
      expect(edit().record.dirty).toBe(true);
      // Longer than any debounce the form ever had.
      yield* Effect.sleep('1 second');
      yield* Effect.promise(() => act(settle));
      expect(sentEdits()).toEqual([]);
      view.unmount();
      yield* Effect.promise(() => act(settle));
      expect(sentEdits()).toEqual([]);
    }),
  );

  it.effect('discard drops the typed change and sends nothing', () =>
    Effect.gen(function* discard() {
      yield* Effect.promise(() => mount(orderOf({ updatedAt: opened }), 7));
      yield* type({ note: 'Zavolat předem' });
      yield* Effect.promise(() =>
        act(async () => {
          edit().record.discard();
          await settle();
        }),
      );
      expect(draft().note).toBe('');
      expect(edit().record.status).toBe('idle');
      expect(sentEdits()).toEqual([]);
    }),
  );
});
