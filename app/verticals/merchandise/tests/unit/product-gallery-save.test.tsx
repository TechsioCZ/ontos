// @rstest-environment happy-dom
// The pictures of the "E-shop a obrázky" tab are part of the tab's draft: an upload stores the file at once but the
// picture joins the public gallery, and order, main picture and removals change, only with the tab's one Uložit. That
// save sends the whole gallery against the catalog revision the draft was read at, so a save over someone else's
// change is refused as a conflict. Only the generated clients, the i18n runtime and the router blocker are replaced.
import { saveLabelsFor } from '@app/admin-ui';
import type { MediaImageUpload } from '@app/core-runtime/media/image-contract';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ChangeProductImagesActionConflictProblemSchema,
  ChangeProductImagesActionIneligibleProblemSchema,
} from '../../shared/apis/change-product-images-action.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { executeChangeProductImages } from '../../src/api/change-product-images-action-client.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import { EshopPanel } from '../../src/routes/[lang]/provoz/produkty/product-eshop-panel.tsx';
import type { StageImage } from '../../src/routes/[lang]/provoz/produkty/product-image-gallery.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/media-client.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('../../src/api/change-product-images-action-client.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

/** The router's blocked navigation: `blocked` while a route change waits for the question's answer. */
interface BlockedNavigation {
  proceeded: number;
  reset: number;
  status: 'blocked' | 'idle';
}
const navigation: BlockedNavigation = {
  proceeded: 0,
  reset: 0,
  status: 'idle',
};
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({
    proceed: () => {
      navigation.proceeded += 1;
    },
    reset: () => {
      navigation.reset += 1;
    },
    status: navigation.status,
  }),
}));

const labels = saveLabelsFor('cs');
/** The locale keys the stubbed i18n runtime shows as names. */
const copy = {
  moveLater: 'merchandise.pages.products.gallery.moveLaterLabel',
  remove: 'merchandise.pages.products.gallery.removeLabel',
  saveRejected: 'merchandise.pages.products.gallery.saveRejected',
};

const first = 'https://www.akros.cz/data/product/first.jpg';
const second = 'https://www.akros.cz/data/product/second.jpg';
const staged = 'media:0192f3a0-0000-7000-8000-0000000000aa';

const product = Schema.decodeSync(ProductRecordSchema)({
  active: true,
  category: 'Zrnková káva',
  createdAt: '2026-10-20T09:00:00.000Z',
  currentPriceMinor: 25_804,
  id: 'product-1',
  images: [first, second],
  lowStock: false,
  lowStockThreshold: 3,
  name: 'Etiopie',
  priceHistory: [],
  sku: 'ETI-250',
  stockOnHand: 12,
  stockValueMinor: 309_648,
  unit: 'ks',
  updatedAt: '2026-10-20T09:00:00.000Z',
  variants: [],
  vatRate: 12,
});

const conflict = Schema.decodeSync(ChangeProductImagesActionConflictProblemSchema)({
  _tag: 'ChangeProductImagesActionConflictProblem',
  code: 'merchandise_revision_conflict',
  detail: 'Changed',
  status: 409,
  title: 'Conflict',
  type: 'urn:test:conflict',
});

const gallerySaves = () =>
  rstest.mocked(executeChangeProductImages).mock.calls.map(([payload]) => ({
    change: payload.command.change,
    expectedRevision: payload.expectedRevision,
  }));

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const unmounts: (() => void)[] = [];
const committed: string[] = [];
const staging: MediaImageUpload[] = [];

/** Stores the picture at once, as the Action does, and names it. */
const stage: StageImage = (image, onOutcome) => {
  staging.push(image);
  onOutcome({ image: staged, ok: true, revision: 7 });
};

const upload: MediaImageUpload = {
  filename: 'detail.png',
  full: { contentBase64: 'AA==', height: 1, width: 1 },
};

const ineligible = Schema.decodeSync(ChangeProductImagesActionIneligibleProblemSchema)({
  _tag: 'ChangeProductImagesActionIneligibleProblem',
  code: 'merchandise_reference_ineligible',
  detail: 'Gone',
  status: 422,
  title: 'Ineligible',
  type: 'urn:test:ineligible',
});

const settingsSaves = () =>
  rstest.mocked(executeManageCatalog).mock.calls.map(([payload]) => ({
    command: payload.command,
    expectedRevision: payload.expectedRevision,
  }));

const mountWith = async ({ canWrite }: { readonly canWrite: boolean }) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const show = async () => {
    await act(async () => {
      root.render(
        <EshopPanel
          canWrite={canWrite}
          canWriteImages
          onCommitted={(message) => {
            committed.push(message);
          }}
          onReload={constVoid}
          prepare={() => Effect.succeed(upload)}
          product={product}
          revision={7}
          stage={stage}
        />,
      );
      await settle();
    });
  };
  await show();
  unmounts.push(() => {
    act(() => {
      root.unmount();
      container.remove();
    });
  });
  return { rerender: show };
};
const mount = () => mountWith({ canWrite: false });

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);
const button = (name: string) => Option.getOrThrow(Option.fromNullishOr(buttons(name)[0]));
const labelled = (name: string) =>
  Option.getOrThrow(Option.fromNullishOr(document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)));
const tiles = () => document.querySelectorAll('[data-testid="gallery-image"]').length;

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

const typeInto = (id: string, value: string) =>
  Effect.promise(() =>
    act(async () => {
      const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`#${id}`)));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    }),
  );

/** Picks a file in the picker's own input (not the form field), as the browser would. */
const pick = (file: File) =>
  Effect.promise(() =>
    act(async () => {
      const input = Option.getOrThrow(
        Option.fromNullOr(document.querySelector<HTMLInputElement>('input[type="file"][id$=":input"]')),
      );
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    }),
  );

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  navigation.proceeded = 0;
  navigation.reset = 0;
  navigation.status = 'idle';
  committed.length = 0;
  staging.length = 0;
  rstest.mocked(executeChangeProductImages).mockReturnValue(Effect.succeed({ entityIds: [], revision: 8 }));
});

afterEach(() => {
  for (const unmount of unmounts) {
    unmount();
  }
  unmounts.length = 0;
  rstest.unstubAllGlobals();
});

it.effect('reordering and removing change only the draft; Uložit sends the gallery once at its revision', () =>
  Effect.gen(function* reorderThenSave() {
    yield* Effect.promise(mount);
    expect(buttons(labels.save)).toHaveLength(1);
    expect(button(labels.save).disabled).toBe(true);

    // "Move later" on the main picture makes the second one main.
    yield* click(labelled(copy.moveLater));
    expect(gallerySaves()).toEqual([]);
    expect(button(labels.save).disabled).toBe(false);

    yield* click(button(labels.save));
    yield* Effect.promise(() => waitUntil(() => committed.length === 1));
    expect(gallerySaves()).toEqual([{ change: { _tag: 'Set', images: [second, first] }, expectedRevision: 7 }]);
    // The settings did not change, so only the gallery was sent.
    expect(executeManageCatalog).not.toHaveBeenCalled();
  }),
);

it.effect('an uploaded picture is stored at once but reaches the e-shop only with Uložit', () =>
  Effect.gen(function* uploadThenSave() {
    yield* Effect.promise(mount);
    yield* pick(new File([new Uint8Array([1])], 'detail.png', { type: 'image/png' }));
    yield* Effect.promise(() => waitUntil(() => tiles() === 3));
    expect(staging).toHaveLength(1);
    // Nothing reached the public gallery yet.
    expect(gallerySaves()).toEqual([]);

    yield* click(button(labels.save));
    yield* Effect.promise(() => waitUntil(() => committed.length === 1));
    expect(gallerySaves()).toEqual([{ change: { _tag: 'Set', images: [first, second, staged] }, expectedRevision: 7 }]);
  }),
);

it.effect('a save over someone else’s newer change is refused as a conflict and keeps the draft', () =>
  Effect.gen(function* staleSave() {
    rstest.mocked(executeChangeProductImages).mockReturnValue(Effect.fail(conflict));
    yield* Effect.promise(mount);
    yield* click(labelled(copy.remove));
    expect(tiles()).toBe(1);
    yield* click(button(labels.save));
    yield* Effect.promise(() => waitUntil(() => buttons(labels.reloadLatest).length === 1));
    expect(gallerySaves()).toHaveLength(1);
    expect(committed).toEqual([]);
    expect(tiles()).toBe(1);
  }),
);

it.effect('leaving with an unsaved gallery asks; Zahodit změny puts the saved gallery back and leaves', () =>
  Effect.gen(function* leave() {
    const view = yield* Effect.promise(mount);
    yield* click(labelled(copy.remove));
    navigation.status = 'blocked';
    yield* Effect.promise(view.rerender);
    expect(buttons(labels.stay)).toHaveLength(1);
    yield* click(button(labels.discard));
    expect(navigation.proceeded).toBe(1);
    expect(tiles()).toBe(2);
    expect(gallerySaves()).toEqual([]);
  }),
);

it.effect('an untouched gallery leaves without asking', () =>
  Effect.gen(function* untouched() {
    const view = yield* Effect.promise(mount);
    navigation.status = 'blocked';
    yield* Effect.promise(view.rerender);
    // A blocked navigation of an untouched tab is not answered by its question.
    expect(buttons(labels.stay)).toHaveLength(0);
  }),
);

it.effect(
  'settings saved before a refused gallery stay saved; the gallery reason shows and Uložit retries it alone',
  () =>
    Effect.gen(function* partlySaved() {
      rstest.mocked(executeManageCatalog).mockReturnValue(Effect.succeed({ entityIds: [], revision: 8 }));
      rstest.mocked(executeChangeProductImages).mockReturnValueOnce(Effect.fail(ineligible));
      yield* Effect.promise(() => mountWith({ canWrite: true }));
      yield* typeInto('eshop-slug', 'etiopie-250');
      yield* click(labelled(copy.remove));
      yield* click(button(labels.save));
      yield* Effect.promise(() => waitUntil(() => (document.body.textContent ?? '').includes(copy.saveRejected)));
      expect(settingsSaves()).toHaveLength(1);
      expect(committed).toEqual([]);
      // The slug went through: it is not reported as taken, and Uložit stays usable for the gallery.
      expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
      expect(button(labels.save).disabled).toBe(false);

      yield* click(button(labels.save));
      yield* Effect.promise(() => waitUntil(() => committed.length === 1));
      expect(settingsSaves()).toHaveLength(1);
      expect(gallerySaves()).toEqual([
        { change: { _tag: 'Set', images: [second] }, expectedRevision: 8 },
        { change: { _tag: 'Set', images: [second] }, expectedRevision: 8 },
      ]);
    }),
);
