import { Option, Schema } from 'effect';
import { ProductIdSchema } from '../../shared/domain/merchandise-model.ts';
import { expect, it } from 'effect-rstest';
import { constVoid } from 'effect/Function';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  appendImage,
  mediaAssetIdOf,
  mediaImageReference,
  removeImage,
  reorderGallery,
  restoreImage,
} from '../../shared/domain/product-images.ts';
import { ProductImageGalleryView } from '../../src/routes/[lang]/provoz/produkty/product-image-gallery.tsx';
import type { ProductImageGalleryViewProps } from '../../src/routes/[lang]/provoz/produkty/product-image-gallery.tsx';
import {
  galleryReducer,
  initialGallery,
  rejectionMessage,
} from '../../src/routes/[lang]/provoz/produkty/product-image-gallery-model.ts';
import type { GalleryState } from '../../src/routes/[lang]/provoz/produkty/product-image-gallery-model.ts';

const first = mediaImageReference('0192f3a0-0000-7000-8000-000000000001');
const second = mediaImageReference('0192f3a0-0000-7000-8000-000000000002');
const third = 'https://www.akros.cz/data/product/18kop009.jpg';

const render = (state: GalleryState, overrides: Partial<ProductImageGalleryViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(ProductImageGalleryView, {
      canWrite: true,
      dispatch: constVoid,
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
  );

const visibleText = (markup: string) => markup.replaceAll(/<[^>]+>/gu, ' ');

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

it('shows a friendly dropzone and no technical text when the product has no image', () => {
  const markup = render(initialGallery([]));
  const text = visibleText(markup);
  expect(text).toContain('Obrázky (0)');
  expect(text).toContain('Přetáhněte sem obrázky nebo klikněte pro výběr');
  expect(text).toContain('JPG, PNG nebo WebP do 20 MB');
  expect(text).not.toMatch(/Přidat|Uložit|obnoven|\/img\/|https?:|media:/u);
});

it('marks the first image as the main one and never prints image references', () => {
  const markup = render(initialGallery([first, second, third]));
  const text = visibleText(markup);
  expect(text).toContain('Obrázky (3)');
  expect(text.match(/Hlavní/gu)).toHaveLength(1);
  expect(markup.indexOf('Hlavní')).toBeLessThan(markup.indexOf('Nastavit obrázek 2 jako hlavní'));
  expect(text).not.toMatch(/media:|akros\.cz|0192f3a0/u);
});

it('shows progress while uploading and a Czech error with retry when an upload fails', () => {
  const queued = galleryReducer(initialGallery([first]), {
    type: 'queued',
    uploads: [
      { key: 'u1', name: 'foto.jpg', phase: 'waiting' },
      { key: 'u2', name: 'detail.png', phase: 'waiting' },
    ],
  });
  const uploading = galleryReducer(queued, { key: 'u1', phase: 'uploading', type: 'phase' });
  const uploadingText = visibleText(render(uploading));
  expect(uploadingText).toContain('Nahrávám…');
  expect(uploadingText).toContain('Čeká…');
  expect(uploadingText).toContain('Nahrávám obrázky (2)…');
  expect(render(uploading)).toContain('<progress');

  const failed = galleryReducer(uploading, {
    key: 'u1',
    message: 'Obrázek se nepodařilo uložit. Zkuste jiný soubor.',
    type: 'uploadFailed',
  });
  const failedText = visibleText(render(failed));
  expect(failedText).toContain('Obrázek se nepodařilo uložit. Zkuste jiný soubor.');
  expect(failedText).toContain('Zkusit znovu');

  const done = galleryReducer(failed, { image: second, key: 'u2', type: 'uploaded' });
  expect(done.images).toEqual([first, second]);
  expect(done.uploads.map((upload) => upload.key)).toEqual(['u1']);
});

it('explains refused files in Czech', () => {
  expect(rejectionMessage('scan.pdf', ['FILE_INVALID_TYPE'], 5)).toBe(
    'Soubor „scan.pdf“ není obrázek ve formátu JPG, PNG nebo WebP.',
  );
  expect(rejectionMessage('raw.png', ['FILE_TOO_LARGE'], 5)).toBe(
    'Soubor „raw.png“ je větší než 20 MB. Zmenšete ho, nebo vyberte jiný.',
  );
  expect(rejectionMessage('a.jpg', ['TOO_MANY_FILES'], 2)).toBe(
    'Produkt může mít nejvýše 20 obrázků. Teď můžete přidat ještě 2.',
  );
  const state = galleryReducer(initialGallery([]), {
    notices: [{ key: 'n1', message: rejectionMessage('scan.pdf', ['FILE_INVALID_TYPE'], 5) }],
    type: 'rejected',
  });
  expect(visibleText(render(state))).toContain('není obrázek ve formátu JPG, PNG nebo WebP');
});

it('reorders optimistically and returns to the saved order when saving fails', () => {
  const moved = galleryReducer(initialGallery([first, second, third]), { from: 2, to: 0, type: 'move' });
  expect(moved.images).toEqual([third, first, second]);
  expect(moved.status).toBe('saving');
  expect(visibleText(render(moved))).toContain('Ukládám…');
  const saved = galleryReducer(moved, { type: 'saved' });
  expect(saved.saved).toEqual([third, first, second]);
  expect(visibleText(render(saved))).toContain('Uloženo');
  const failed = galleryReducer(moved, { message: 'Obrázky produktu se mezitím změnily.', type: 'saveFailed' });
  expect(failed.images).toEqual([first, second, third]);
  // A server read during a save does not overwrite the person's pending order.
  expect(galleryReducer(moved, { images: [first, second, third], type: 'server' }).images).toEqual([
    third,
    first,
    second,
  ]);
});

it('removes an image with an undo that puts it back at its place', () => {
  const removed = galleryReducer(initialGallery([first, second, third]), { image: second, type: 'remove' });
  expect(removed.images).toEqual([first, third]);
  expect(removed.removed).toEqual({ image: second, position: 1 });
  const text = visibleText(render(removed));
  expect(text).toContain('Obrázek byl odebrán.');
  expect(text).toContain('Vrátit zpět');
  const restored = galleryReducer(removed, { type: 'undo' });
  expect(restored.images).toEqual([first, second, third]);
  expect(restored.removed).toBeUndefined();
  expect(galleryReducer(removed, { type: 'undoExpired' }).removed).toBeUndefined();
});

it('shows no editing controls to a person without write access', () => {
  const text = visibleText(render(initialGallery([first]), { canWrite: false }));
  expect(text).toContain('Hlavní');
  expect(text).not.toMatch(/Přetáhněte|Odebrat|Vybrat obrázky/u);
});
