// @rstest-environment happy-dom
import { Effect, Option, Schema } from 'effect';
import { ProductIdSchema } from '../../shared/domain/merchandise-model.ts';
import { afterEach, expect, it } from 'effect-rstest';
import { settle, unmountAll } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { MediaApi, MediaResponseSchema } from '../../shared/apis/media.ts';
import { moduleCopy, moduleText, mountInRoute } from '../support/module-ui.ts';
import { constVoid } from 'effect/Function';
import { createElement } from 'react';
import {
  appendImage,
  mediaAssetIdOf,
  mediaImageReference,
  removeImage,
  reorderGallery,
  restoreImage,
  setGallery,
} from '../../shared/domain/product-images.ts';
import { ProductImageGalleryView } from '../../src/routes/[lang]/provoz/produkty/product-image-gallery.tsx';
import type { ProductImageGalleryViewProps } from '../../src/routes/[lang]/provoz/produkty/product-image-gallery.tsx';
import {
  galleryReducer,
  initialGallery,
  rejectionMessage,
  withMoved,
  withRestored,
  withStaged,
  withoutImage,
} from '../../src/routes/[lang]/provoz/produkty/product-image-gallery-model.ts';
import type { GalleryState } from '../../src/routes/[lang]/provoz/produkty/product-image-gallery-model.ts';

const translate = moduleText('cs');

afterEach(unmountAll);

const first = mediaImageReference('0192f3a0-0000-7000-8000-000000000001');
const second = mediaImageReference('0192f3a0-0000-7000-8000-000000000002');
const third = 'https://www.akros.cz/data/product/18kop009.jpg';

const OwnerMediaApi = MediaApi.prefix('/merchandise-api');
const mediaResponse = Schema.decodeSync(MediaResponseSchema)({
  contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/wAAAABJRU5ErkJggg==',
  contentSha256: 'b202ba81cb3bccec00460b0ab1e54f5d536f6b360a85df95d4f58b8aaa5c6b9e',
  mimeType: 'image/png',
});
const mediaNetwork = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerMediaApi,
    HttpApiBuilder.group(OwnerMediaApi, 'media', (group) =>
      group.handle('execute', () => Effect.succeed(mediaResponse)),
    ),
  ),
);

const render = (
  images: readonly string[],
  state: GalleryState = initialGallery(),
  overrides: Partial<ProductImageGalleryViewProps> = {},
) =>
  Effect.gen(function* renderGallery() {
    unmountAll();
    yield* pinTestDocument;
    yield* mountInRoute(
      createElement(ProductImageGalleryView, {
        canWrite: true,
        dispatch: constVoid,
        images,
        onFiles: constVoid,
        onMove: constVoid,
        onRemove: constVoid,
        onRetry: constVoid,
        onUndo: constVoid,
        productId: Schema.decodeSync(ProductIdSchema)('product-1'),
        productName: 'Šroub M8',
        state,
        ...overrides,
      }),
      {
        path: 'provoz/produkty',
        settle: networkIdle.pipe(Effect.andThen(settle)),
        url: '/cs/provoz/produkty',
      },
    );
    return new XMLSerializer().serializeToString(document.body);
  }).pipe(Effect.provide(mediaNetwork));

const visibleText = (markup: string) => markup.replaceAll(/<[^>]+>/gu, ' ');

it.live('renders the gallery count and upload status with Czech plural forms', () =>
  Effect.gen(function* galleryCase() {
    for (const [count, title, uploading] of [
      [1, 'Obrázek (1)', 'Nahrávám 1 obrázek…'],
      [2, 'Obrázky (2)', 'Nahrávám 2 obrázky…'],
      [4, 'Obrázky (4)', 'Nahrávám 4 obrázky…'],
      [5, 'Obrázky (5)', 'Nahrávám 5 obrázků…'],
      [20, 'Obrázky (20)', 'Nahrávám 20 obrázků…'],
    ] as const) {
      const images = Array.from({ length: count }, (_, index) => `https://www.akros.cz/image-${index}.jpg`);
      const state = galleryReducer(initialGallery(), {
        type: 'queued',
        uploads: images.map((name, index) => ({ key: `u${index}`, name, phase: 'waiting' })),
      });
      const text = visibleText(yield* render(images, state, { canWrite: false }));
      expect(text).toContain(title);
      expect(text).toContain(uploading);
    }
    const emptyText = visibleText(yield* render([], initialGallery(), { canWrite: false }));
    expect(emptyText).toContain('Obrázky (0)');
    expect(emptyText).not.toContain('Nahrávám');
  }),
);

it('resolves gallery translations natively in both locales, including zero and fractional counts', () => {
  for (const [language, count, title, uploading] of [
    ['cs', 0, 'Obrázky (0)', 'Nahrávám 0 obrázků…'],
    ['cs', 1, 'Obrázek (1)', 'Nahrávám 1 obrázek…'],
    ['cs', 2, 'Obrázky (2)', 'Nahrávám 2 obrázky…'],
    ['cs', 4, 'Obrázky (4)', 'Nahrávám 4 obrázky…'],
    ['cs', 5, 'Obrázky (5)', 'Nahrávám 5 obrázků…'],
    ['cs', 1.5, 'Obrázky (1.5)', 'Nahrávám 1.5 obrázku…'],
    ['en', 0, 'Images (0)', 'Uploading 0 images…'],
    ['en', 1, 'Image (1)', 'Uploading 1 image…'],
    ['en', 2, 'Images (2)', 'Uploading 2 images…'],
    ['en', 5, 'Images (5)', 'Uploading 5 images…'],
    ['en', 1.5, 'Images (1.5)', 'Uploading 1.5 images…'],
  ] as const) {
    const t = moduleCopy(language).getFixedT(language);
    expect(t('merchandise.pages.products.gallery.title', { count })).toBe(title);
    expect(t('merchandise.pages.products.gallery.uploading', { count })).toBe(uploading);
  }
});

it('recognises only uploaded-image references as Core Media Assets', () => {
  expect(Option.getOrUndefined(mediaAssetIdOf(first))).toBe('0192f3a0-0000-7000-8000-000000000001');
  expect(Option.isNone(mediaAssetIdOf(third))).toBe(true);
  expect(Option.isNone(mediaAssetIdOf('media:../../etc'))).toBe(true);
});

it('applies gallery changes only against the current gallery', () => {
  expect(Option.getOrUndefined(appendImage([first], second))).toEqual([first, second]);
  expect(Option.getOrUndefined(reorderGallery([first, second], [second, first]))).toEqual([second, first]);
  // A reorder made against an older gallery would drop or resurrect an image.
  expect(Option.isNone(reorderGallery([first, second], [second]))).toBe(true);
  expect(Option.isNone(reorderGallery([first], [first, third]))).toBe(true);
  expect(Option.getOrUndefined(removeImage([first, second], first))).toEqual([second]);
  expect(Option.isNone(removeImage([second], first))).toBe(true);
  expect(Option.getOrUndefined(restoreImage([second], first, 0))).toEqual([first, second]);
  expect(
    Option.isNone(
      appendImage(
        Array.from({ length: 20 }, (_, index) => `${third}?${index}`),
        first,
      ),
    ),
  ).toBe(true);
});

it('saves a whole gallery draft only with stored pictures, each once', () => {
  // Staged pictures join, outside addresses can stay, order and removals follow the draft.
  expect(Option.getOrUndefined(setGallery([first, third], [second, third]))).toEqual([second, third]);
  expect(Option.isNone(setGallery([first], [first, first]))).toBe(true);
  expect(Option.isNone(setGallery([first], [first, 'https://elsewhere.example/x.jpg']))).toBe(true);
  expect(
    Option.isNone(
      setGallery(
        [],
        Array.from({ length: 21 }, (_, index) =>
          mediaImageReference(`0192f3a0-0000-7000-8000-${String(index).padStart(12, '0')}`),
        ),
      ),
    ),
  ).toBe(true);
});

it.live('shows a friendly dropzone and no technical text when the product has no image', () =>
  Effect.gen(function* galleryCase() {
    const markup = yield* render([]);
    const text = visibleText(markup);
    expect(text).toContain('Obrázky (0)');
    expect(text).toContain('Přetáhněte sem obrázky nebo klikněte pro výběr');
    expect(text).toContain('JPG, PNG nebo WebP do 20 MB');
    // The intro names the tab's Uložit (pictures reach the e-shop only with it); the gallery has no button of its own.
    expect(text).toContain('až po uložení tlačítkem Uložit');
    expect(markup).not.toMatch(/<button[^>]*>[^<]*Uložit/u);
    expect(text).not.toMatch(/Přidat|obnoven|\/img\/|https?:|media:/u);
  }),
);

it.live('marks the first image as the main one and never prints image references', () =>
  Effect.gen(function* galleryCase() {
    const markup = yield* render([first, second, third]);
    const text = visibleText(markup);
    expect(text).toContain('Obrázky (3)');
    expect(text.match(/Hlavní/gu)).toHaveLength(1);
    expect(markup.indexOf('Hlavní')).toBeLessThan(markup.indexOf('Nastavit obrázek 2 jako hlavní'));
    expect(text).not.toMatch(/media:|akros\.cz|0192f3a0/u);
  }),
);

it.live('shows progress while uploading and a Czech error with retry when an upload fails', () =>
  Effect.gen(function* galleryCase() {
    const queued = galleryReducer(initialGallery(), {
      type: 'queued',
      uploads: [
        { key: 'u1', name: 'foto.jpg', phase: 'waiting' },
        { key: 'u2', name: 'detail.png', phase: 'waiting' },
      ],
    });
    const uploading = galleryReducer(queued, { key: 'u1', phase: 'uploading', type: 'phase' });
    const uploadingText = visibleText(yield* render([first], uploading));
    expect(uploadingText).toContain('Nahrávám…');
    expect(uploadingText).toContain('Čeká…');
    expect(uploadingText).toContain('Nahrávám 2 obrázky…');
    expect(yield* render([first], uploading)).toContain('<progress');

    const failed = galleryReducer(uploading, {
      key: 'u1',
      message: 'Obrázek se nepodařilo uložit. Zkuste jiný soubor.',
      type: 'uploadFailed',
    });
    const failedText = visibleText(yield* render([first], failed));
    expect(failedText).toContain('Obrázek se nepodařilo uložit. Zkuste jiný soubor.');
    expect(failedText).toContain('Zkusit znovu');

    // A stored upload leaves the queue and joins the draft at the end; the public gallery waits for Uložit.
    const done = galleryReducer(failed, { key: 'u2', type: 'uploaded' });
    expect(done.uploads.map((upload) => upload.key)).toEqual(['u1']);
    expect(withStaged([first], second)).toEqual([first, second]);
    expect(withStaged([first, second], second)).toEqual([first, second]);
  }),
);

it.live('explains refused files in Czech', () =>
  Effect.gen(function* galleryCase() {
    expect(rejectionMessage(translate, 'scan.pdf', ['FILE_INVALID_TYPE'], 5)).toBe(
      'Soubor „scan.pdf“ není obrázek ve formátu JPG, PNG nebo WebP.',
    );
    expect(rejectionMessage(translate, 'raw.png', ['FILE_TOO_LARGE'], 5)).toBe(
      'Soubor „raw.png“ je větší než 20 MB. Zmenšete ho, nebo vyberte jiný.',
    );
    expect(rejectionMessage(translate, 'a.jpg', ['TOO_MANY_FILES'], 2)).toBe(
      'Produkt může mít nejvýše 20 obrázků. Teď můžete přidat ještě 2.',
    );
    const state = galleryReducer(initialGallery(), {
      notices: [{ key: 'n1', message: rejectionMessage(translate, 'scan.pdf', ['FILE_INVALID_TYPE'], 5) }],
      type: 'rejected',
    });
    expect(visibleText(yield* render([], state))).toContain('není obrázek ve formátu JPG, PNG nebo WebP');
  }),
);

it.live('reorders and removes in the draft only, with an undo that puts the picture back at its place', () =>
  Effect.gen(function* galleryCase() {
    expect(withMoved([first, second, third], 2, 0)).toEqual([third, first, second]);
    const draft = withoutImage([first, second, third], second);
    expect(draft).toEqual([first, third]);
    const removed = galleryReducer(initialGallery(), { removed: { image: second, position: 1 }, type: 'removed' });
    const text = visibleText(yield* render(draft, removed));
    expect(text).toContain('Obrázek je odebraný z konceptu. Z e-shopu zmizí po uložení.');
    expect(text).toContain('Vrátit zpět');
    // No save status of its own: the tab's save bar tells whether the gallery is saved.
    expect(text).not.toMatch(/Ukládám|Uloženo/u);
    expect(withRestored(draft, { image: second, position: 1 })).toEqual([first, second, third]);
    expect(galleryReducer(removed, { type: 'undone' }).removed).toBeUndefined();
    expect(galleryReducer(removed, { type: 'undoExpired' }).removed).toBeUndefined();
    // A discarded draft has the picture again: nothing is left to undo.
    expect(visibleText(yield* render([first, second, third], removed))).not.toContain('Vrátit zpět');
  }),
);

it.live('shows no editing controls to a person without write access', () =>
  Effect.gen(function* galleryCase() {
    const text = visibleText(yield* render([first], initialGallery(), { canWrite: false }));
    expect(text).toContain('Hlavní');
    expect(text).not.toMatch(/Přetáhněte|Odebrat|Vybrat obrázky/u);
  }),
);
