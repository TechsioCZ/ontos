// @rstest-environment happy-dom
// Mounted product detail draft: the real `useProductDetailAutosave` the editor uses, with the real autosave
// controller and save. Only the generated catalog client is replaced, by a register that refuses every command that
// does not expect its current revision. The editor stays mounted while its product reloads, so `product` still
// shows the version before a save until that reload lands.
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ManageCatalogActionConflictProblemSchema } from '../../shared/apis/manage-catalog-action.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import type { ProductRecord } from '../../shared/domain/merchandise-model.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import { useProductDetailAutosave } from '../../src/routes/[lang]/provoz/produkty/product-detail-autosave.ts';
import type { DetailDraft } from '../../src/routes/[lang]/provoz/produkty/product-detail-draft.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/manage-catalog-action-client.ts');

const productOf = (fields: { readonly description?: string; readonly name?: string }): ProductRecord =>
  Schema.decodeSync(ProductRecordSchema)({
    active: true,
    category: 'Zrnková káva',
    createdAt: '2026-10-20T09:00:00.000Z',
    currentPriceMinor: 25_804,
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

/** The catalog: one revision for the whole company, and a command must expect exactly the current one. */
const register = { revision: 1 };

const answerLikeTheRegister = () => {
  rstest.mocked(executeManageCatalog).mockImplementation(({ expectedRevision }) =>
    Effect.suspend(() => {
      if (expectedRevision !== register.revision) {
        return Effect.fail(conflict);
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
    return {
      expectedRevision: payload.expectedRevision,
      patch: command._tag === 'UpdateProduct' ? command.patch : undefined,
      tag: command._tag,
    };
  });

type ProductEdit = ReturnType<typeof useProductDetailAutosave>;

let latest: ProductEdit | null = null;
const edit = (): ProductEdit => Option.getOrThrow(Option.fromNullOr(latest));

const Harness = ({ product, revision }: { readonly product: ProductRecord; readonly revision: number }) => {
  const value = useProductDetailAutosave({ product, revision });
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
      edit().autosave.setDraft((current) => ({ ...current, ...patch }));
      await settle();
    }),
  );

/** Blur: the pending change is sent now. Resolves once the autosave has settled. */
const saveNow = Effect.promise(async () => {
  await act(async () => {
    edit().autosave.flush();
    await settle();
  });
  await waitUntil(() => !['dirty', 'saving'].includes(edit().autosave.status));
});

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
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
      expect(edit().autosave.status).toBe('saved');

      // The reload after that save is still on its way: the page shows the product named `Etiopie`.
      yield* type({ name: 'Etiopie' });
      yield* saveNow;
      expect(sent()).toEqual([
        { expectedRevision: 1, patch: { name: 'Etiopie B' }, tag: 'UpdateProduct' },
        { expectedRevision: 2, patch: { name: 'Etiopie' }, tag: 'UpdateProduct' },
      ]);
      expect(edit().autosave.status).toBe('saved');

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
      expect(edit().autosave.status).toBe('saved');
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
      expect(edit().autosave.status).toBe('saved');
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
      expect(edit().autosave.status).toBe('conflict');
    }),
  );

  it.effect('a save that went through clears the approval notice of an earlier refused save', () =>
    Effect.gen(function* approvalNotice() {
      yield* Effect.promise(() => mount(productOf({}), 1));
      const receipt = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
        _tag: 'ActionProposalAccepted',
        expiresAt: '2026-11-10T12:00:00.000Z',
        proposalId: '60000000-0000-4000-8000-000000000001',
      });
      rstest.mocked(executeManageCatalog).mockReturnValueOnce(Effect.succeed(receipt));
      yield* type({ name: 'Etiopie B' });
      yield* saveNow;
      expect(edit().autosave.status).toBe('error');
      expect(edit().pendingMessage).not.toBeNull();

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
