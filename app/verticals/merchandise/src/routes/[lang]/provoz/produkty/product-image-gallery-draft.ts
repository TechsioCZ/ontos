// The behaviour of the gallery editor over the tab's draft: uploads (stored at once, one after another, then added
// to the draft), reorder, removal with undo. Nothing here changes the public gallery; the tab's Uložit does.
import type { MediaImageUpload } from '@app/core-runtime/media/image-contract';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Fiber } from 'effect';
import { useEffect, useReducer, useRef } from 'react';
import type { ProductId } from '../../../../../shared/domain/merchandise-model.ts';
import { pendingProposalMessage } from '../../../../api/action-result.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import {
  galleryReducer,
  initialGallery,
  withMoved,
  withRestored,
  withStaged,
  withoutImage,
} from './product-image-gallery-model.ts';
import type { GalleryTranslate } from './product-image-gallery-model.ts';
import { prepareImageUpload } from './product-image-prepare.ts';
import type { ImagePreparationFailed } from './product-image-prepare.ts';
import { rememberLocalPreview } from './product-image-source.ts';
import { runCommand } from './products-api.ts';
import type { CommandOutcome } from './products-api.ts';

const UNDO_WINDOW_MS = 10_000;

/** Stores one uploaded picture for the product; a successful outcome names the stored picture. */
export type StageImage = (image: MediaImageUpload, onOutcome: (outcome: CommandOutcome) => void) => void;

/** Stores the picture through the merchandise Action without putting it into the public gallery. */
const stageThroughAction =
  (productId: ProductId): StageImage =>
  (image, onOutcome) =>
    // A stored picture changes no product data, so it waits for no revision.
    runCommand({ _tag: 'ChangeProductImages', change: { _tag: 'Stage', image }, id: productId }, 0, onOutcome);

/** The person's message for a refused upload. */
const uploadFailureMessage = (t: GalleryTranslate, outcome: CommandOutcome) => {
  if (outcome.ok) {
    return '';
  }
  if (outcome.proposal !== undefined) {
    return pendingProposalMessage(outcome.proposal) ?? '';
  }
  if (outcome.reason === 'forbidden') {
    return t('merchandise.pages.products.gallery.forbidden');
  }
  if (outcome.reason === 'rejected' || outcome.reason === 'conflict') {
    return t('merchandise.pages.products.gallery.uploadRejected');
  }
  return t('merchandise.pages.products.gallery.unavailable');
};

export interface GalleryDraftOptions {
  /** The gallery as the tab's draft has it. */
  readonly images: readonly string[];
  /** Changes the tab's draft; nothing is sent. */
  readonly onImagesChange: (update: (current: readonly string[]) => readonly string[]) => void;
  readonly prepare?: (file: File) => Effect.Effect<MediaImageUpload, ImagePreparationFailed>;
  readonly productId: ProductId;
  readonly stage?: StageImage | undefined;
}

interface QueuedFile {
  readonly file: File;
  readonly key: string;
}

export const useGalleryDraft = ({
  images,
  onImagesChange,
  prepare = prepareImageUpload,
  productId,
  stage,
}: GalleryDraftOptions) => {
  const { t } = useModernI18n();
  const [state, dispatch] = useReducer(galleryReducer, undefined, initialGallery);
  const run = stage ?? stageThroughAction(productId);
  const queue = useRef<QueuedFile[]>([]);
  const files = useRef(new Map<string, File>());
  const previews = useRef(new Map<string, string>());
  const draining = useRef(false);
  const sequence = useRef(0);

  const { removed } = state;
  useEffect(() => {
    const timer =
      removed === undefined
        ? undefined
        : browserRuntime.runFork(
            Effect.sleep(UNDO_WINDOW_MS).pipe(Effect.andThen(Effect.sync(() => dispatch({ type: 'undoExpired' })))),
          );
    return () => {
      if (timer !== undefined) {
        browserRuntime.runFork(Fiber.interrupt(timer));
      }
    };
  }, [removed]);

  const finishUpload = (next: QueuedFile, outcome: CommandOutcome) => {
    if (outcome.ok && outcome.image !== undefined) {
      const preview = previews.current.get(next.key);
      if (preview !== undefined) {
        rememberLocalPreview(productId, outcome.image, 'thumbnail', preview);
        rememberLocalPreview(productId, outcome.image, 'full', preview);
      }
      files.current.delete(next.key);
      const stored = outcome.image;
      dispatch({ key: next.key, type: 'uploaded' });
      // The picture joins the draft; the public gallery gets it with Uložit.
      onImagesChange((current) => withStaged(current, stored));
      return;
    }
    dispatch({ key: next.key, message: uploadFailureMessage(t, outcome), type: 'uploadFailed' });
  };

  const drain = (): void => {
    const next = draining.current ? undefined : queue.current.shift();
    if (next === undefined) {
      return;
    }
    draining.current = true;
    const settle = () => {
      draining.current = false;
      drain();
    };
    dispatch({ key: next.key, phase: 'preparing', type: 'phase' });
    browserRuntime.runFork(
      prepare(next.file).pipe(
        Effect.match({
          onFailure: (error) => {
            dispatch({
              key: next.key,
              message: t('merchandise.pages.products.gallery.preparationFailed', { name: next.file.name }),
              type: 'uploadFailed',
            });
            settle();
            return error;
          },
          onSuccess: (image) => {
            dispatch({ key: next.key, phase: 'uploading', type: 'phase' });
            run(image, (outcome) => {
              finishUpload(next, outcome);
              settle();
            });
            return image;
          },
        }),
      ),
    );
  };

  const enqueue = (chosen: readonly File[]) => {
    const uploads = chosen.map((file) => {
      sequence.current += 1;
      const key = `upload-${sequence.current}`;
      const preview = URL.createObjectURL(file);
      files.current.set(key, file);
      previews.current.set(key, preview);
      queue.current.push({ file, key });
      return { key, name: file.name, phase: 'waiting' as const, preview };
    });
    dispatch({ type: 'queued', uploads });
    drain();
  };

  const retry = (key: string) => {
    const file = files.current.get(key);
    if (file !== undefined) {
      queue.current.push({ file, key });
      dispatch({ key, phase: 'waiting', type: 'phase' });
      drain();
    }
  };

  const move = (from: number, to: number) => {
    onImagesChange((current) => withMoved(current, from, to));
  };

  const remove = (image: string) => {
    const position = images.indexOf(image);
    if (position !== -1) {
      dispatch({ removed: { image, position }, type: 'removed' });
      onImagesChange((current) => withoutImage(current, image));
    }
  };

  const undo = () => {
    if (removed !== undefined) {
      dispatch({ type: 'undone' });
      onImagesChange((current) => withRestored(current, removed));
    }
  };

  return { dispatch, enqueue, move, remove, retry, state, undo };
};
