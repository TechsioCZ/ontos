// Product gallery editor: drop, pick or paste pictures, reorder, choose the main one and remove. It edits the draft of
// the "E-shop a obrázky" tab: an upload stores the file at once, but the picture joins the public gallery, and order,
// main picture and removals change, only when the tab's Uložit saves the draft. The first image is the main one.
import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FileUpload } from '@techsio/ui-kit/molecules/file-upload';
import { SectionCard } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';
import type { ProductId } from '../../../../../shared/domain/merchandise-model.ts';
import { PRODUCT_GALLERY_LIMIT } from '../../../../../shared/domain/product-images.ts';
import { activeUploads, rejectionMessage } from './product-image-gallery-model.ts';
import type { GalleryEvent, GalleryState } from './product-image-gallery-model.ts';
import { GalleryTile, UploadTile } from './product-image-gallery-tiles.tsx';
import { useGalleryDraft } from './product-image-gallery-draft.ts';
import type { GalleryDraftOptions } from './product-image-gallery-draft.ts';
import { ACCEPTED_IMAGE_TYPES, MAX_SOURCE_IMAGE_BYTES } from './product-image-prepare.ts';

export type { StageImage } from './product-image-gallery-draft.ts';

export interface ProductImageGalleryViewProps {
  readonly canWrite: boolean;
  readonly dispatch: (event: GalleryEvent) => void;
  /** The gallery as the draft has it. */
  readonly images: readonly string[];
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
  images,
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
  const uploading = activeUploads(state).length;
  const remaining = Math.max(0, PRODUCT_GALLERY_LIMIT - images.length - uploading);
  const empty = images.length === 0 && state.uploads.length === 0;
  // A removal the draft no longer shows (it was discarded or saved back) has nothing left to undo.
  const undoable = state.removed !== undefined && !images.includes(state.removed.image);
  const handleDragOver = (event: DragEvent, index: number) => {
    if (dragFrom !== null && dragFrom !== index) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  };
  const handleDrop = (index: number) => {
    if (dragFrom !== null && dragFrom !== index) {
      onMove(dragFrom, index);
    }
    setDragFrom(null);
  };
  return (
    <SectionCard title={t('merchandise.pages.products.gallery.title', { count: images.length })}>
      <p className="text-fg-secondary text-sm">
        {canWrite
          ? t('merchandise.pages.products.gallery.intro')
          : t('merchandise.pages.products.gallery.introReadOnly')}
      </p>
      {(images.length > 0 || state.uploads.length > 0) && (
        <ul className="grid grid-cols-2 gap-200 sm:grid-cols-4" data-testid="gallery-grid">
          {images.map((image, index) => (
            <GalleryTile
              canWrite={canWrite}
              count={images.length}
              dragging={dragFrom === index}
              image={image}
              index={index}
              key={image}
              onDragEnd={() => setDragFrom(null)}
              onDragOver={handleDragOver}
              onDragStart={setDragFrom}
              onDrop={handleDrop}
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
      {undoable && (
        <div className="flex flex-wrap items-center gap-150" data-testid="gallery-undo">
          <StatusText status="default">{t('merchandise.pages.products.gallery.removed')}</StatusText>
          <Button onClick={onUndo} size="sm" theme="outlined" type="button" variant="secondary">
            {t('merchandise.pages.products.gallery.undo')}
          </Button>
        </div>
      )}
      {uploading > 0 && (
        <p aria-live="polite" className="text-fg-secondary text-sm" data-testid="gallery-status">
          {t('merchandise.pages.products.gallery.uploading', { count: uploading })}
        </p>
      )}
    </SectionCard>
  );
};

export type ProductImageGalleryProps = GalleryDraftOptions & {
  readonly canWrite: boolean;
  readonly productName: string;
};

/** The gallery editor over the tab's draft; uploads run one after another in the chosen order. */
export const ProductImageGallery = ({ canWrite, productName, ...options }: ProductImageGalleryProps) => {
  const {
    dispatch,
    enqueue: handleFiles,
    move: handleMove,
    remove: handleRemove,
    retry: handleRetry,
    state,
    undo: handleUndo,
  } = useGalleryDraft(options);
  return (
    <ProductImageGalleryView
      canWrite={canWrite}
      dispatch={dispatch}
      images={options.images}
      onFiles={handleFiles}
      onMove={handleMove}
      onRemove={handleRemove}
      onRetry={handleRetry}
      onUndo={handleUndo}
      productId={options.productId}
      productName={productName}
      state={state}
    />
  );
};
