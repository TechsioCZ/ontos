// Product gallery editor: drop, pick or paste pictures; every finished upload, reorder and removal is saved at once.
// The first image is the main one. Pictures go to Core Media through the merchandise Action; nothing technical
// (addresses, paths, identifiers) is ever shown.
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FileUpload } from '@techsio/ui-kit/molecules/file-upload';
import { SectionCard, surfaceTileClassName } from '@app/admin-ui';
import { Effect, Fiber } from 'effect';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';
import type { MediaImageUpload } from '@app/core-runtime/media/image-contract';
import type { ProductImageChange } from '../../../../../shared/actions/apply-command.ts';
import type { ProductId } from '../../../../../shared/domain/merchandise-model.ts';
import { PRODUCT_GALLERY_LIMIT } from '../../../../../shared/domain/product-images.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { activeUploads, galleryReducer, initialGallery, rejectionMessage } from './product-image-gallery-model.ts';
import type { GalleryEvent, GalleryState, GalleryTranslate, PendingUpload } from './product-image-gallery-model.ts';
import { ACCEPTED_IMAGE_TYPES, MAX_SOURCE_IMAGE_BYTES, prepareImageUpload } from './product-image-prepare.ts';
import type { ImagePreparationFailed } from './product-image-prepare.ts';
import { rememberLocalPreview, useImageSource } from './product-image-source.ts';
import type { CommandOutcome } from './products-api.ts';
import { runCommand } from './products-api.ts';

const UNDO_WINDOW_MS = 10_000;

export type ChangeImages = (change: ProductImageChange, onOutcome: (outcome: ImageChangeOutcome) => void) => void;
export type ImageChangeOutcome = CommandOutcome;

/** Runs one gallery change through the merchandise Action; an upload's outcome names the stored image. */
const changeThroughAction =
  (productId: ProductId): ChangeImages =>
  (change, onOutcome) =>
    runCommand({ _tag: 'ChangeProductImages', change, id: productId }, 0, onOutcome);

const failureMessage = (
  t: GalleryTranslate,
  outcome: ImageChangeOutcome,
  action: 'move' | 'remove' | 'restore' | 'upload',
) => {
  if (outcome.ok) {
    return '';
  }
  if (outcome.reason === 'forbidden') {
    return t('merchandise.pages.products.gallery.forbidden');
  }
  if (outcome.reason === 'rejected' || outcome.reason === 'conflict') {
    return action === 'upload'
      ? t('merchandise.pages.products.gallery.uploadRejected')
      : t('merchandise.pages.products.gallery.conflict');
  }
  return t('merchandise.pages.products.gallery.unavailable');
};

const statusText = (t: GalleryTranslate, state: GalleryState) => {
  const uploading = activeUploads(state).length;
  if (uploading > 0) {
    return uploading === 1
      ? t('merchandise.pages.products.gallery.uploadingOne')
      : t('merchandise.pages.products.gallery.uploadingMany', { count: uploading });
  }
  if (state.status === 'saving') {
    return t('merchandise.pages.products.gallery.saving');
  }
  return state.status === 'saved' ? t('merchandise.pages.products.gallery.saved') : undefined;
};

/** Upload stages a person can follow: waiting, preparing the picture, sending it (then it joins the gallery). */
const phaseStep = { failed: 0, preparing: 1, uploading: 2, waiting: 0 } as const;
const phaseText = (t: GalleryTranslate, phase: PendingUpload['phase']) =>
  ({
    failed: t('merchandise.pages.products.gallery.phaseFailed'),
    preparing: t('merchandise.pages.products.gallery.phasePreparing'),
    uploading: t('merchandise.pages.products.gallery.phaseUploading'),
    waiting: t('merchandise.pages.products.gallery.phaseWaiting'),
  })[phase];

interface TileProps {
  readonly canWrite: boolean;
  readonly count: number;
  readonly dragging: boolean;
  readonly image: string;
  readonly index: number;
  readonly onDragEnd: () => void;
  readonly onDragOver: (event: DragEvent, index: number) => void;
  readonly onDragStart: (index: number) => void;
  readonly onDrop: (index: number) => void;
  readonly onMove: (from: number, to: number) => void;
  readonly onRemove: (image: string) => void;
  readonly productId: ProductId;
  readonly productName: string;
}

const GalleryTile = ({
  canWrite,
  count,
  dragging,
  image,
  index,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onMove,
  onRemove,
  productId,
  productName,
}: TileProps) => {
  const { t } = useModernI18n();
  const source = useImageSource(productId, image, 'thumbnail');
  const position = index + 1;
  return (
    <li className={`flex flex-col gap-100 ${dragging ? 'opacity-50' : ''}`} data-testid="gallery-image">
      <div
        className={`${surfaceTileClassName} relative flex aspect-square items-center justify-center overflow-hidden ${canWrite ? 'cursor-grab' : ''}`}
        draggable={canWrite}
        onDragEnd={onDragEnd}
        onDragOver={(event) => onDragOver(event, index)}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          onDragStart(index);
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDrop(index);
        }}
      >
        {source.status === 'ready' ? (
          <img
            alt={t('merchandise.pages.products.gallery.imageAlt', { name: productName, position })}
            className="size-full object-cover"
            draggable={false}
            loading="lazy"
            src={source.src}
          />
        ) : (
          <span className="p-100 text-center text-fg-secondary text-xs">
            {source.status === 'loading'
              ? t('merchandise.pages.products.gallery.loadingPreview')
              : t('merchandise.pages.products.gallery.previewUnavailable')}
          </span>
        )}
        {index === 0 && (
          <span className="absolute top-100 left-100">
            <Badge size="sm" variant="info">
              {t('merchandise.pages.products.gallery.main')}
            </Badge>
          </span>
        )}
      </div>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-50">
          {index > 0 && (
            <Button
              aria-label={t('merchandise.pages.products.gallery.setMainLabel', { position })}
              icon="icon-[mdi--star-outline]"
              onClick={() => onMove(index, 0)}
              size="sm"
              theme="borderless"
              title={t('merchandise.pages.products.gallery.setMain')}
              type="button"
              variant="secondary"
            />
          )}
          <Button
            aria-label={t('merchandise.pages.products.gallery.moveEarlierLabel', { position })}
            disabled={index === 0}
            icon="icon-[mdi--arrow-left]"
            onClick={() => onMove(index, index - 1)}
            size="sm"
            theme="borderless"
            title={t('merchandise.pages.products.gallery.moveEarlier')}
            type="button"
            variant="secondary"
          />
          <Button
            aria-label={t('merchandise.pages.products.gallery.moveLaterLabel', { position })}
            disabled={index === count - 1}
            icon="icon-[mdi--arrow-right]"
            onClick={() => onMove(index, index + 1)}
            size="sm"
            theme="borderless"
            title={t('merchandise.pages.products.gallery.moveLater')}
            type="button"
            variant="secondary"
          />
          <Button
            aria-label={t('merchandise.pages.products.gallery.removeLabel', { position })}
            className="ml-auto"
            icon="icon-[mdi--delete-outline]"
            onClick={() => onRemove(image)}
            size="sm"
            theme="borderless"
            title={t('merchandise.pages.products.gallery.remove')}
            type="button"
            variant="secondary"
          />
        </div>
      )}
    </li>
  );
};

const UploadTile = ({
  onDismiss,
  onRetry,
  upload,
}: {
  readonly onDismiss: (key: string) => void;
  readonly onRetry: (key: string) => void;
  readonly upload: PendingUpload;
}) => {
  const { t } = useModernI18n();
  const phase = phaseText(t, upload.phase);
  return (
    <li className="flex flex-col gap-100" data-testid="gallery-upload">
      <div
        className={`${surfaceTileClassName} relative flex aspect-square items-center justify-center overflow-hidden`}
      >
        {upload.preview !== undefined && (
          <img
            alt=""
            className={`size-full object-cover ${upload.phase === 'failed' ? 'opacity-40' : 'opacity-60'}`}
            src={upload.preview}
          />
        )}
        <div className="absolute inset-x-100 bottom-100 flex flex-col gap-50">
          <span className="truncate rounded-sm bg-base/90 px-50 text-xs">{upload.name}</span>
          {upload.phase !== 'failed' && (
            <progress
              aria-label={`${upload.name}: ${phase}`}
              className="h-1 w-full accent-primary"
              max={3}
              value={phaseStep[upload.phase]}
            />
          )}
        </div>
      </div>
      <span className={`text-xs ${upload.phase === 'failed' ? 'text-fg-danger' : 'text-fg-secondary'}`}>
        {upload.phase === 'failed' ? (upload.message ?? phase) : phase}
      </span>
      {upload.phase === 'failed' && (
        <div className="flex gap-50">
          <Button onClick={() => onRetry(upload.key)} size="sm" theme="outlined" type="button" variant="secondary">
            {t('merchandise.pages.products.gallery.retry')}
          </Button>
          <Button onClick={() => onDismiss(upload.key)} size="sm" theme="borderless" type="button" variant="secondary">
            {t('merchandise.pages.products.gallery.dismiss')}
          </Button>
        </div>
      )}
    </li>
  );
};

export interface ProductImageGalleryViewProps {
  readonly canWrite: boolean;
  readonly dispatch: (event: GalleryEvent) => void;
  readonly onFiles: (files: readonly File[]) => void;
  readonly onMove: (from: number, to: number) => void;
  readonly onRemove: (image: string) => void;
  readonly onRetry: (key: string) => void;
  readonly onUndo: () => void;
  readonly productId: ProductId;
  readonly productName: string;
  readonly state: GalleryState;
}

/** The gallery as the person sees it; all behaviour arrives through the callbacks. */
export const ProductImageGalleryView = ({
  canWrite,
  dispatch,
  onFiles,
  onMove,
  onRemove,
  onRetry,
  onUndo,
  productId,
  productName,
  state,
}: ProductImageGalleryViewProps) => {
  const { t } = useModernI18n();
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const remaining = Math.max(0, PRODUCT_GALLERY_LIMIT - state.images.length - activeUploads(state).length);
  const empty = state.images.length === 0 && state.uploads.length === 0;
  const status = statusText(t, state);
  const dragOver = (event: DragEvent, index: number) => {
    if (dragFrom !== null && dragFrom !== index) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  };
  const drop = (index: number) => {
    if (dragFrom !== null && dragFrom !== index) {
      onMove(dragFrom, index);
    }
    setDragFrom(null);
  };
  return (
    <SectionCard title={t('merchandise.pages.products.gallery.title', { count: state.images.length })}>
      <p className="text-fg-secondary text-sm">
        {canWrite
          ? t('merchandise.pages.products.gallery.intro')
          : t('merchandise.pages.products.gallery.introReadOnly')}
      </p>
      {(state.images.length > 0 || state.uploads.length > 0) && (
        <ul className="grid grid-cols-2 gap-200 sm:grid-cols-4" data-testid="gallery-grid">
          {state.images.map((image, index) => (
            <GalleryTile
              canWrite={canWrite}
              count={state.images.length}
              dragging={dragFrom === index}
              image={image}
              index={index}
              key={image}
              onDragEnd={() => setDragFrom(null)}
              onDragOver={dragOver}
              onDragStart={setDragFrom}
              onDrop={drop}
              onMove={onMove}
              onRemove={onRemove}
              productId={productId}
              productName={productName}
            />
          ))}
          {state.uploads.map((upload) => (
            <UploadTile
              key={upload.key}
              onDismiss={(key) => dispatch({ key, type: 'dismissUpload' })}
              onRetry={onRetry}
              upload={upload}
            />
          ))}
        </ul>
      )}
      {empty && !canWrite && (
        <p className="text-fg-secondary text-sm">{t('merchandise.pages.products.gallery.empty')}</p>
      )}
      {canWrite && (
        <FileUpload
          accept={ACCEPTED_IMAGE_TYPES}
          acceptedFiles={[]}
          disabled={remaining === 0}
          maxFiles={Math.max(1, remaining)}
          maxFileSize={MAX_SOURCE_IMAGE_BYTES}
          name="productImages"
          onFileAccept={({ files }) => onFiles(files)}
          onFileReject={({ files }) =>
            dispatch({
              notices: files.map(({ errors, file }, index) => ({
                key: `${file.name}-${file.lastModified}-${index}-${state.notices.length}`,
                message: rejectionMessage(t, file.name, errors, remaining),
              })),
              type: 'rejected',
            })
          }
        >
          <FileUpload.Context>
            {(api) => (
              <FileUpload.Dropzone
                className={empty ? 'min-h-48' : 'min-h-24'}
                data-testid="gallery-dropzone"
                onPaste={(event: ClipboardEvent<HTMLDivElement>) => {
                  if (event.clipboardData.files.length > 0) {
                    event.preventDefault();
                    api.setClipboardFiles(event.clipboardData);
                  }
                }}
                tabIndex={0}
              >
                <Icon aria-hidden="true" color="secondary" icon="icon-[mdi--image-plus-outline]" size="2xl" />
                <span className="font-medium">
                  {remaining === 0
                    ? t('merchandise.pages.products.gallery.dropzoneFull', { limit: PRODUCT_GALLERY_LIMIT })
                    : t('merchandise.pages.products.gallery.dropzonePrompt')}
                </span>
                <span className="text-fg-secondary text-sm">
                  {t('merchandise.pages.products.gallery.dropzoneHint')}
                </span>
                <FileUpload.Trigger disabled={remaining === 0}>
                  {t('merchandise.pages.products.gallery.pick')}
                </FileUpload.Trigger>
              </FileUpload.Dropzone>
            )}
          </FileUpload.Context>
          <FileUpload.HiddenInput />
        </FileUpload>
      )}
      {state.notices.map((notice) => (
        <div className="flex items-center justify-between gap-150" key={notice.key}>
          <StatusText showIcon status="error">
            {notice.message}
          </StatusText>
          <Button
            aria-label={t('merchandise.pages.products.gallery.hideNotice')}
            icon="icon-[mdi--close]"
            onClick={() => dispatch({ key: notice.key, type: 'dismissNotice' })}
            size="sm"
            theme="borderless"
            type="button"
            variant="secondary"
          />
        </div>
      ))}
      {state.removed !== undefined && (
        <div className="flex flex-wrap items-center gap-150" data-testid="gallery-undo">
          <StatusText status="default">{t('merchandise.pages.products.gallery.removed')}</StatusText>
          <Button onClick={onUndo} size="sm" theme="outlined" type="button" variant="secondary">
            {t('merchandise.pages.products.gallery.undo')}
          </Button>
        </div>
      )}
      {status !== undefined && (
        <p aria-live="polite" className="text-fg-secondary text-sm" data-testid="gallery-status">
          {status}
        </p>
      )}
    </SectionCard>
  );
};

export interface ProductImageGalleryProps {
  readonly canWrite: boolean;
  readonly change?: ChangeImages;
  readonly images: readonly string[];
  /** Reads the product again after a saved change (no message, no manual step). */
  readonly onChanged: () => void;
  readonly prepare?: (file: File) => Effect.Effect<MediaImageUpload, ImagePreparationFailed>;
  readonly productId: ProductId;
  readonly productName: string;
}

interface QueuedFile {
  readonly file: File;
  readonly key: string;
}

/** The gallery editor wired to the merchandise Action; uploads run one after another in the chosen order. */
export const ProductImageGallery = ({
  canWrite,
  change,
  images,
  onChanged,
  prepare = prepareImageUpload,
  productId,
  productName,
}: ProductImageGalleryProps) => {
  const { t } = useModernI18n();
  const [state, dispatch] = useReducer(galleryReducer, images, initialGallery);
  const run = change ?? changeThroughAction(productId);
  const queue = useRef<QueuedFile[]>([]);
  const files = useRef(new Map<string, File>());
  const previews = useRef(new Map<string, string>());
  const draining = useRef(false);
  const sequence = useRef(0);
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);

  const serverKey = images.join('\n');
  useEffect(() => {
    dispatch({ images: serverKey === '' ? [] : serverKey.split('\n'), type: 'server' });
  }, [serverKey]);

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

  const finishUpload = (next: QueuedFile, outcome: ImageChangeOutcome) => {
    if (outcome.ok && outcome.image !== undefined) {
      const preview = previews.current.get(next.key);
      if (preview !== undefined) {
        rememberLocalPreview(productId, outcome.image, 'thumbnail', preview);
        rememberLocalPreview(productId, outcome.image, 'full', preview);
      }
      files.current.delete(next.key);
      dispatch({ image: outcome.image, key: next.key, type: 'uploaded' });
      onChanged();
      return;
    }
    dispatch({ key: next.key, message: failureMessage(t, outcome, 'upload'), type: 'uploadFailed' });
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
            run({ _tag: 'Upload', image }, (outcome) => {
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

  const save = (action: 'move' | 'remove' | 'restore', imageChange: ProductImageChange) =>
    run(imageChange, (outcome) => {
      dispatch(outcome.ok ? { type: 'saved' } : { message: failureMessage(t, outcome, action), type: 'saveFailed' });
      onChanged();
    });

  const move = (from: number, to: number) => {
    const before = latest.current;
    const after = galleryReducer(before, { from, to, type: 'move' });
    if (after !== before) {
      dispatch({ from, to, type: 'move' });
      save('move', { _tag: 'Reorder', images: after.images });
    }
  };

  const remove = (image: string) => {
    dispatch({ image, type: 'remove' });
    save('remove', { _tag: 'Remove', image });
  };

  const undo = () => {
    const pending = latest.current.removed;
    if (pending !== undefined) {
      dispatch({ type: 'undo' });
      save('restore', { _tag: 'Restore', image: pending.image, position: pending.position });
    }
  };

  return (
    <ProductImageGalleryView
      canWrite={canWrite}
      dispatch={dispatch}
      onFiles={enqueue}
      onMove={move}
      onRemove={remove}
      onRetry={retry}
      onUndo={undo}
      productId={productId}
      productName={productName}
      state={state}
    />
  );
};
