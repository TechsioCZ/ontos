// @rstest-environment happy-dom
// Mounted product detail draft: the real `useProductDetailDraft` the editor uses, with the real draft
// controller and save. Only the generated catalog client is replaced, by a register that refuses every command that
// does not expect its current revision. The editor stays mounted while its product reloads, so `product` still
// shows the version before a save until that reload lands.
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Effect, Option, Predicate, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ManageCatalogActionConflictProblemSchema,
  ManageCatalogActionUnavailableProblemSchema,
} from '../../shared/apis/manage-catalog-action.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import type { ProductRecord } from '../../shared/domain/merchandise-model.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import { useProductDetailDraft } from '../../src/routes/[lang]/provoz/produkty/product-detail-save.ts';
import type { DetailDraft } from '../../src/routes/[lang]/provoz/produkty/product-detail-draft.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/manage-catalog-action-client.ts');

const productOf = (fields: {
  readonly description?: string;
  readonly name?: string;
  readonly priceMinor?: number;
}): ProductRecord =>
  Schema.decodeSync(ProductRecordSchema)({
    active: true,
    category: 'Zrnková káva',
    createdAt: '2026-10-20T09:00:00.000Z',
    currentPriceMinor: fields.priceMinor ?? 25_804,
    description: fields.description ?? 'Etiopie, 250 g.',
    id: 'product-1',
    lowStock: false,
    lowStockThreshold: 3,
    name: fields.name ?? 'Etiopie',
    priceHistory: [],
    shortDescription: 'Svěží káva',
    sku: 'ETI-250',
    stockOnHand: 12,
    stockValueMinor: 309_648,
    unit: 'ks',
    updatedAt: '2026-10-20T09:00:00.000Z',
    variants: [],
    vatRate: 12,
  });

const conflict = Schema.decodeSync(ManageCatalogActionConflictProblemSchema)({
  _tag: 'ManageCatalogActionConflictProblem',
  code: 'merchandise_revision_conflict',
  detail: 'Changed',
  status: 409,
  title: 'Conflict',
  type: 'urn:test:conflict',
});

const unavailable = Schema.decodeSync(ManageCatalogActionUnavailableProblemSchema)({
  _tag: 'ManageCatalogActionUnavailableProblem',
  code: 'merchandise_persistence_unavailable',
  detail: 'Try again',
  retryable: true,
  status: 503,
  title: 'Unavailable',
  type: 'urn:test:unavailable',
});

/**
 * The catalog: one revision for the whole company, and a command must expect exactly the current one. While
 * `priceChangesFail` is set, a price change is refused without changing anything.
 */
const register = { priceChangesFail: false, revision: 1 };

/** Why the register refuses a command, or null when it takes it. */
const refusalOf = (tag: string, expectedRevision: number): typeof conflict | typeof unavailable | null => {
  if (tag === 'ChangePrice' && register.priceChangesFail) {
    return unavailable;
  }
  return expectedRevision === register.revision ? null : conflict;
};

const answerLikeTheRegister = () => {
  rstest.mocked(executeManageCatalog).mockImplementation(({ command, expectedRevision }) =>
    Effect.suspend(() => {
      const refusal = refusalOf(command._tag, expectedRevision);
      if (refusal !== null) {
        return Effect.fail(refusal);
      }
      register.revision += 1;
      return Effect.succeed({ entityIds: [], revision: register.revision });
    }),
  );
};

/** Every command the register received, with the revision it expected. */
const sent = () =>
  rstest.mocked(executeManageCatalog).mock.calls.map(([payload]) => {
    const { command } = payload;
    return Predicate.isTagged(command, 'ChangePrice')
      ? { expectedRevision: payload.expectedRevision, priceMinor: command.priceMinor, tag: command._tag }
      : {
          expectedRevision: payload.expectedRevision,
          patch: Predicate.isTagged(command, 'UpdateProduct') ? command.patch : undefined,
          tag: command._tag,
        };
  });

type ProductEdit = ReturnType<typeof useProductDetailDraft>;

let latest: ProductEdit | null = null;
const edit = (): ProductEdit => Option.getOrThrow(Option.fromNullOr(latest));

const Harness = ({ product, revision }: { readonly product: ProductRecord; readonly revision: number }) => {
  const value = useProductDetailDraft({ product, revision });
  useEffect(() => {
    latest = value;
  }, [value]);
  return null;
};

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

interface Mounted {
  /** The page hands the mounted editor another read of the same product. */
  readonly reload: (product: ProductRecord, revision: number) => Effect.Effect<void>;
  readonly unmount: () => void;
}

const mounted: Mounted[] = [];

const mount = async (product: ProductRecord, revision: number): Promise<Mounted> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const show = async (nextProduct: ProductRecord, nextRevision: number) => {
    await act(async () => {
      root.render(createElement(Harness, { product: nextProduct, revision: nextRevision }));
      await settle();
    });
  };
  let live = true;
  const view: Mounted = {
    reload: (nextProduct, nextRevision) => Effect.promise(() => show(nextProduct, nextRevision)),
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
  await show(product, revision);
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

const type = (patch: Partial<DetailDraft>) =>
  Effect.promise(() =>
    act(async () => {
      edit().record.setDraft((current) => ({ ...current, ...patch }));
      await settle();
    }),
  );

/** The Save button: the changed draft is sent now. Resolves once the save has settled. */
const saveNow = Effect.promise(async () => {
  await act(async () => {
    edit().record.save();
    await settle();
  });
  await waitUntil(() => !['dirty', 'saving'].includes(edit().record.status));
});

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  register.priceChangesFail = false;
  register.revision = 1;
  answerLikeTheRegister();
  latest = null;
});

afterEach(() => {
  for (const view of mounted) {
    view.unmount();
  }
  mounted.length = 0;
  rstest.unstubAllGlobals();
});

describe('mounted product detail draft while its product reloads', () => {
  it.effect('taking a just-saved field back is sent, so the reload does not bring the saved value back', () =>
    Effect.gen(function* revert() {
      const view = yield* Effect.promise(() => mount(productOf({}), 1));
      yield* type({ name: 'Etiopie B' });
      yield* saveNow;
      expect(edit().record.status).toBe('saved');

      // The reload after that save is still on its way: the page shows the product named `Etiopie`.
      yield* type({ name: 'Etiopie' });
      yield* saveNow;
      expect(sent()).toEqual([
        { expectedRevision: 1, patch: { name: 'Etiopie B' }, tag: 'UpdateProduct' },
        { expectedRevision: 2, patch: { name: 'Etiopie' }, tag: 'UpdateProduct' },
      ]);
      expect(edit().record.status).toBe('saved');

      // The reload lands with what the register now has, and the field keeps what the user chose.
      yield* view.reload(productOf({}), 3);
      expect(edit().draft.name).toBe('Etiopie');
    }),
  );

  it.effect('an edit after a save sends only what changed since that save', () =>
    Effect.gen(function* resend() {
      yield* Effect.promise(() => mount(productOf({}), 1));
      yield* type({ name: 'Etiopie B' });
      yield* saveNow;

      yield* type({ lowStock: 5, lowStockText: '5' });
      yield* saveNow;
      expect(sent()[1]).toEqual({ expectedRevision: 2, patch: { lowStockThreshold: 5 }, tag: 'UpdateProduct' });
      expect(edit().record.status).toBe('saved');
    }),
  );

  it.effect('an edit typed right after a stock movement of the page is saved, not refused as a conflict', () =>
    Effect.gen(function* afterMovement() {
      yield* Effect.promise(() => mount(productOf({}), 1));
      // The movement form's command replaced revision 1 with 2; the product on the page is still the one read at 1.
      register.revision = 2;
      edit().followStockCommit(1, 2);

      yield* type({ name: 'Etiopie B' });
      yield* saveNow;
      expect(sent()).toEqual([{ expectedRevision: 2, patch: { name: 'Etiopie B' }, tag: 'UpdateProduct' }]);
      expect(edit().record.status).toBe('saved');
    }),
  );

  it.effect('a stock movement moves only a draft based on the revision that movement replaced', () =>
    Effect.gen(function* otherRevision() {
      yield* Effect.promise(() => mount(productOf({}), 1));
      // Someone else changed the catalog to revision 4 first; the movement replaced 4 with 5.
      register.revision = 5;
      edit().followStockCommit(4, 5);

      yield* type({ name: 'Etiopie B' });
      yield* saveNow;
      expect(sent()).toEqual([{ expectedRevision: 1, patch: { name: 'Etiopie B' }, tag: 'UpdateProduct' }]);
      expect(edit().record.status).toBe('conflict');
    }),
  );

  it.effect('after a save whose price change failed, taking the written name back is sent with the price', () =>
    Effect.gen(function* partialThenRevert() {
      const view = yield* Effect.promise(() => mount(productOf({}), 1));
      register.priceChangesFail = true;
      yield* type({ name: 'Etiopie B', priceCzk: 300, priceText: '300' });
      yield* saveNow;
      // The name went through and left revision 2; the price did not.
      expect(sent()).toEqual([
        { expectedRevision: 1, patch: { name: 'Etiopie B' }, tag: 'UpdateProduct' },
        { expectedRevision: 2, priceMinor: 30_000, tag: 'ChangePrice' },
      ]);
      expect(edit().record.status).toBe('error');

      // The reload lands with what the register has: the new name, the old price. The draft stays as typed.
      yield* view.reload(productOf({ name: 'Etiopie B' }), 2);
      expect(edit().draft.name).toBe('Etiopie B');
      expect(edit().draft.priceCzk).toBe(300);

      // The name goes back to what the form opened with, and the price is tried again.
      register.priceChangesFail = false;
      yield* type({ name: 'Etiopie' });
      yield* saveNow;
      expect(sent().slice(2)).toEqual([
        { expectedRevision: 2, patch: { name: 'Etiopie' }, tag: 'UpdateProduct' },
        { expectedRevision: 3, priceMinor: 30_000, tag: 'ChangePrice' },
      ]);
      expect(edit().record.status).toBe('saved');

      yield* view.reload(productOf({ priceMinor: 30_000 }), 4);
      expect(edit().draft.name).toBe('Etiopie');
      expect(edit().record.status).toBe('saved');
    }),
  );

  it.effect('after a save whose price change failed, taking both changes back still restores the name', () =>
    Effect.gen(function* partialThenRevertAll() {
      const view = yield* Effect.promise(() => mount(productOf({}), 1));
      register.priceChangesFail = true;
      yield* type({ name: 'Etiopie B', priceCzk: 300, priceText: '300' });
      yield* saveNow;
      expect(edit().record.status).toBe('error');
      yield* view.reload(productOf({ name: 'Etiopie B' }), 2);

      // Back to exactly what the form opened with: the register still has the changed name.
      yield* type({ name: 'Etiopie', priceCzk: 258.04, priceText: '258,04' });
      yield* saveNow;
      expect(sent().slice(2)).toEqual([{ expectedRevision: 2, patch: { name: 'Etiopie' }, tag: 'UpdateProduct' }]);
      expect(edit().record.status).toBe('saved');
    }),
  );

  it.effect('retrying a save whose price change failed sends only the price, after the revision the name left', () =>
    Effect.gen(function* partialThenRetry() {
      yield* Effect.promise(() => mount(productOf({}), 1));
      register.priceChangesFail = true;
      yield* type({ name: 'Etiopie B', priceCzk: 300, priceText: '300' });
      yield* saveNow;
      expect(edit().record.status).toBe('error');

      // The reload has not landed: the page still shows the old name at revision 1.
      register.priceChangesFail = false;
      yield* Effect.promise(() =>
        act(async () => {
          edit().record.save();
          await settle();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => edit().record.status === 'saved'));
      expect(sent().slice(2)).toEqual([{ expectedRevision: 2, priceMinor: 30_000, tag: 'ChangePrice' }]);
    }),
  );

  it.effect('a price change that failed on its own leaves the confirmed version where it was', () =>
    Effect.gen(function* priceOnly() {
      yield* Effect.promise(() => mount(productOf({}), 1));
      register.priceChangesFail = true;
      yield* type({ priceCzk: 300, priceText: '300' });
      yield* saveNow;
      expect(sent()).toEqual([{ expectedRevision: 1, priceMinor: 30_000, tag: 'ChangePrice' }]);
      expect(edit().record.status).toBe('error');

      // Taking the price back leaves nothing to save.
      yield* type({ priceCzk: 258.04, priceText: '258,04' });
      yield* saveNow;
      expect(sent()).toHaveLength(1);
      expect(edit().record.status).toBe('idle');
    }),
  );

  it.effect('a save parked for approval is held: Save does not send it again, a further edit is sent', () =>
    Effect.gen(function* approval() {
      yield* Effect.promise(() => mount(productOf({}), 1));
      const receipt = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
        _tag: 'ActionProposalAccepted',
        expiresAt: '2026-11-10T12:00:00.000Z',
        proposalId: '60000000-0000-4000-8000-000000000001',
      });
      rstest.mocked(executeManageCatalog).mockReturnValueOnce(Effect.succeed(receipt));
      yield* type({ name: 'Etiopie B' });
      yield* saveNow;
      expect(edit().record.status).toBe('proposed');
      expect(edit().record.dirty).toBe(false);
      expect(edit().record.canSave).toBe(false);

      yield* saveNow;
      expect(sent()).toHaveLength(1);

      yield* type({ name: 'Etiopie C' });
      expect(edit().record.status).toBe('dirty');
      yield* saveNow;
      expect(sent()).toHaveLength(2);
      expect(edit().record.status).toBe('saved');
    }),
  );

  it.live('typing never sends anything: not after any delay, not on unmount', () =>
    Effect.gen(function* noAutomaticSave() {
      const view = yield* Effect.promise(() => mount(productOf({}), 1));
      yield* type({ name: 'Etiopie B' });
      expect(edit().record.status).toBe('dirty');
      expect(edit().record.dirty).toBe(true);
      expect(edit().record.canSave).toBe(true);
      // Longer than any debounce the form ever had.
      yield* Effect.sleep('1 second');
      yield* Effect.promise(() => act(settle));
      expect(sent()).toEqual([]);
      view.unmount();
      yield* Effect.promise(() => act(settle));
      expect(sent()).toEqual([]);
    }),
  );

  it.effect('an invalid draft is held back by the Save button', () =>
    Effect.gen(function* invalid() {
      yield* Effect.promise(() => mount(productOf({}), 1));
      yield* type({ name: '' });
      expect(edit().record.status).toBe('invalid');
      expect(edit().record.canSave).toBe(false);
      yield* saveNow;
      expect(sent()).toEqual([]);
    }),
  );

  it.effect('discard puts the confirmed version back without sending anything', () =>
    Effect.gen(function* discard() {
      yield* Effect.promise(() => mount(productOf({}), 1));
      yield* type({ name: 'Etiopie B' });
      yield* Effect.promise(() =>
        act(async () => {
          edit().record.discard();
          await settle();
        }),
      );
      expect(edit().draft.name).toBe('Etiopie');
      expect(edit().record.status).toBe('idle');
      expect(sent()).toEqual([]);
    }),
  );
});
