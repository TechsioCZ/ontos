// @rstest-environment happy-dom
// The pictures of the "E-shop a obrázky" tab are part of the tab's draft: an upload stores the file at once but the
// picture joins the public gallery, and order, main picture and removals change, only with the tab's one Uložit. That
// save sends the whole gallery against the catalog revision the draft was read at, so a save over someone else's
// change is refused as a conflict. Real clients, translations and router run against in-process HTTP contracts.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import type { MediaImageUpload } from '@app/core-runtime/media/image-contract';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Layer, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { act } from 'react';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { changeProductImagesActionSchemaErrorLive } from '../../api/change-product-images-action-problems.ts';
import { manageCatalogActionSchemaErrorLive } from '../../api/manage-catalog-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import {
  ChangeProductImagesActionApi,
  ChangeProductImagesActionConflictProblemSchema,
  ChangeProductImagesActionIneligibleProblemSchema,
} from '../../shared/apis/change-product-images-action.ts';
import type {
  ChangeProductImagesActionProblem,
  ChangeProductImagesPayloadSchema,
} from '../../shared/apis/change-product-images-action.ts';
import { ManageCatalogActionApi } from '../../shared/apis/manage-catalog-action.ts';
import type { ManageCatalogPayloadSchema } from '../../shared/apis/manage-catalog-action.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { EshopPanel } from '../../src/routes/[lang]/provoz/produkty/product-eshop-panel.tsx';
import type { StageImage } from '../../src/routes/[lang]/provoz/produkty/product-image-gallery.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const t = moduleText('cs');
const copy = {
  moveLater: t('merchandise.pages.products.gallery.moveLaterLabel', { position: 1 }),
  remove: t('merchandise.pages.products.gallery.removeLabel', { position: 1 }),
  saveRejected: t('merchandise.pages.products.gallery.saveRejected'),
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

const galleryRequests: (typeof ChangeProductImagesPayloadSchema.Encoded)[] = [];
const settingsRequests: (typeof ManageCatalogPayloadSchema.Encoded)[] = [];
const saved = Schema.decodeSync(ApplyCommandResultSchema)({ entityIds: [], revision: 8 });
let galleryAnswer: Effect.Effect<typeof saved, ChangeProductImagesActionProblem> = Effect.succeed(saved);
const OwnerGalleryApi = ChangeProductImagesActionApi.prefix('/merchandise-api');
const OwnerSettingsApi = ManageCatalogActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerGalleryApi,
    HttpApiBuilder.group(OwnerGalleryApi, 'changeProductImagesAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          galleryRequests.push(payload);
          return galleryAnswer;
        }),
      ),
    ).pipe(Layer.provide(changeProductImagesActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerSettingsApi,
    HttpApiBuilder.group(OwnerSettingsApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          settingsRequests.push(payload);
          return saved;
        }),
      ),
    ).pipe(Layer.provide(manageCatalogActionSchemaErrorLive)),
  ),
);

const gallerySaves = () =>
  galleryRequests.map((payload) => ({
    change: payload.command.change,
    expectedRevision: payload.expectedRevision,
  }));

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
  settingsRequests.map((payload) => ({
    command: payload.command,
    expectedRevision: payload.expectedRevision,
  }));

const mountWith = ({
  canWrite,
  stageImage = stage,
}: {
  readonly canWrite: boolean;
  readonly stageImage?: StageImage;
}) =>
  mountInRoute(
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
      stage={stageImage}
    />,
  );
const mount = () => mountWith({ canWrite: false });

const button = (name: string) => Option.getOrThrow(Option.fromNullishOr(buttons(name)[0]));
const labelled = (name: string) =>
  Option.getOrThrow(Option.fromNullishOr(document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)));
const tiles = () => document.querySelectorAll('[data-testid="gallery-image"]').length;

const click = (element: HTMLElement) =>
  acted(() => {
    element.click();
  });

const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`#${id}`)));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

/** Picks a file in the picker's own input (not the form field), as the browser would. */
const pick = (file: File) =>
  acted(() => {
    const input = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLInputElement>('input[type="file"][id$=":input"]')),
    );
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  committed.length = 0;
  staging.length = 0;
  galleryRequests.length = 0;
  settingsRequests.length = 0;
  galleryAnswer = Effect.succeed(saved);
});

afterEach(unmountAll);

it.live('reordering and removing change only the draft; Uložit sends the gallery once at its revision', () =>
  Effect.gen(function* reorderThenSave() {
    yield* pinTestDocument;
    yield* mount();
    expect(buttons(labels.save)).toHaveLength(1);
    expect(button(labels.save).disabled).toBe(true);

    // "Move later" on the main picture makes the second one main.
    yield* click(labelled(copy.moveLater));
    yield* networkIdle;
    expect(gallerySaves()).toEqual([]);
    expect(button(labels.save).disabled).toBe(false);

    yield* click(button(labels.save));
    yield* waitUntil(() => committed.length === 1);
    yield* networkIdle;
    expect(gallerySaves()).toEqual([{ change: { _tag: 'Set', images: [second, first] }, expectedRevision: 7 }]);
    // The settings did not change, so only the gallery was sent.
    expect(settingsRequests).toEqual([]);
  }).pipe(Effect.provide(network)),
);

it.live('an uploaded picture is stored at once but reaches the e-shop only with Uložit', () =>
  Effect.gen(function* uploadThenSave() {
    yield* pinTestDocument;
    const stagedDone = yield* Deferred.make<true>();
    yield* mountWith({
      canWrite: false,
      stageImage: (image, onOutcome) => {
        stage(image, onOutcome);
        Deferred.doneUnsafe(stagedDone, Effect.succeed(true));
      },
    });
    yield* pick(new File([new Uint8Array([1])], 'detail.png', { type: 'image/png' }));
    yield* Deferred.await(stagedDone);
    yield* waitUntil(() => tiles() === 3);
    yield* waitUntil(() => !button(labels.save).disabled);
    yield* networkIdle;
    expect(staging).toHaveLength(1);
    // Nothing reached the public gallery yet.
    expect(gallerySaves()).toEqual([]);

    yield* click(button(labels.save));
    yield* waitUntil(() => committed.length === 1);
    yield* networkIdle;
    expect(gallerySaves()).toEqual([{ change: { _tag: 'Set', images: [first, second, staged] }, expectedRevision: 7 }]);
  }).pipe(Effect.provide(network)),
);

it.live('a save over someone else’s newer change is refused as a conflict and keeps the draft', () =>
  Effect.gen(function* staleSave() {
    galleryAnswer = Effect.fail(conflict);
    yield* pinTestDocument;
    yield* mount();
    yield* click(labelled(copy.remove));
    expect(tiles()).toBe(1);
    yield* click(button(labels.save));
    yield* waitUntil(() => buttons(labels.reloadLatest).length === 1);
    yield* networkIdle;
    expect(gallerySaves()).toHaveLength(1);
    expect(committed).toEqual([]);
    expect(tiles()).toBe(1);
  }).pipe(Effect.provide(network)),
);

it.live('an untouched gallery leaves without asking', () =>
  Effect.gen(function* untouched() {
    yield* pinTestDocument;
    const view = yield* mount();
    yield* Effect.promise(() =>
      act(async () => {
        await view.router.navigate({ to: '/cs/other' });
      }),
    );
    yield* networkIdle;
    expect(view.router.state.location.pathname).toBe('/cs/other');
    expect(buttons(labels.stay)).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live(
  'settings saved before a refused gallery stay saved; the gallery reason shows and Uložit retries it alone',
  () =>
    Effect.gen(function* partlySaved() {
      galleryAnswer = Effect.fail(ineligible);
      yield* pinTestDocument;
      yield* mountWith({ canWrite: true });
      yield* typeInto('eshop-slug', 'etiopie-250');
      yield* click(labelled(copy.remove));
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(copy.saveRejected));
      yield* networkIdle;
      expect(settingsSaves()).toHaveLength(1);
      expect(committed).toEqual([]);
      // The slug went through: it is not reported as taken, and Uložit stays usable for the gallery.
      expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
      expect(button(labels.save).disabled).toBe(false);

      galleryAnswer = Effect.succeed(saved);
      yield* click(button(labels.save));
      yield* waitUntil(() => committed.length === 1);
      yield* networkIdle;
      expect(settingsSaves()).toHaveLength(1);
      expect(gallerySaves()).toEqual([
        { change: { _tag: 'Set', images: [second] }, expectedRevision: 8 },
        { change: { _tag: 'Set', images: [second] }, expectedRevision: 8 },
      ]);
    }).pipe(Effect.provide(network)),
);
