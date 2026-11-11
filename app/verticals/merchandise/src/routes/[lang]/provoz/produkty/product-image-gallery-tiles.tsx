// The tiles of the product gallery editor: one picture of the draft with its order controls, and one upload in
// flight. Nothing technical (addresses, paths, identifiers) is ever shown.
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { DragEvent } from 'react';
import type { ProductId } from '../../../../../shared/domain/merchandise-model.ts';
import type { GalleryTranslate, PendingUpload } from './product-image-gallery-model.ts';
import { useImageSource } from './product-image-source.ts';

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

export const GalleryTile = ({
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

export const UploadTile = ({
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
