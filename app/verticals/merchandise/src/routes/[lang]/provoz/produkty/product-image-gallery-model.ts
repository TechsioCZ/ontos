// State of the product gallery editor around its draft: the uploads in flight, the notices and the one removal that
// can still be undone. The gallery itself (order, main picture, which pictures) is the draft of the "E-shop a
// obrázky" tab and is saved with that tab's Uložit. Pure, so every state is testable.
import { Match, Option, Schema } from 'effect';
import { PRODUCT_GALLERY_LIMIT, moveImage, restoreImage } from '../../../../../shared/domain/product-images.ts';

export const UploadPhaseSchema = Schema.Literals(['failed', 'preparing', 'uploading', 'waiting']);
export type UploadPhase = typeof UploadPhaseSchema.Type;

export interface PendingUpload {
  readonly key: string;
  readonly message?: string;
  readonly name: string;
  readonly phase: UploadPhase;
  /** Local object URL of the chosen file, shown until the stored image replaces it. */
  readonly preview?: string;
}

export interface GalleryNotice {
  readonly key: string;
  readonly message: string;
}

/** A picture taken out of the draft, which "Vrátit zpět" puts back at its place. */
export interface RemovedImage {
  readonly image: string;
  readonly position: number;
}

export interface GalleryState {
  readonly notices: readonly GalleryNotice[];
  readonly removed?: RemovedImage;
  readonly uploads: readonly PendingUpload[];
}

export type GalleryEvent =
  | { readonly removed: RemovedImage; readonly type: 'removed' }
  | { readonly type: 'undone' }
  | { readonly type: 'undoExpired' }
  | { readonly type: 'queued'; readonly uploads: readonly PendingUpload[] }
  | { readonly key: string; readonly phase: UploadPhase; readonly type: 'phase' }
  | { readonly key: string; readonly message: string; readonly type: 'uploadFailed' }
  | { readonly key: string; readonly type: 'uploaded' }
  | { readonly key: string; readonly type: 'dismissUpload' }
  | { readonly notices: readonly GalleryNotice[]; readonly type: 'rejected' }
  | { readonly key: string; readonly type: 'dismissNotice' };

export const initialGallery = (): GalleryState => ({ notices: [], uploads: [] });

/** Uploads still waiting for their turn or on the wire; a failed one only waits for the person. */
export const activeUploads = (state: GalleryState) => state.uploads.filter((upload) => upload.phase !== 'failed');

const withoutRemoved = ({ removed: _removed, ...rest }: GalleryState): GalleryState => rest;

const updateUpload = (state: GalleryState, key: string, change: Partial<PendingUpload>) =>
  state.uploads.map((upload) => (upload.key === key ? { ...upload, ...change } : upload));

export const galleryReducer = (state: GalleryState, event: GalleryEvent): GalleryState =>
  Match.value(event).pipe(
    Match.discriminatorsExhaustive('type')({
      dismissNotice: ({ key }) => ({ ...state, notices: state.notices.filter((notice) => notice.key !== key) }),
      dismissUpload: ({ key }) => ({ ...state, uploads: state.uploads.filter((upload) => upload.key !== key) }),
      phase: ({ key, phase }) => ({ ...state, uploads: updateUpload(state, key, { phase }) }),
      queued: ({ uploads }) => ({ ...state, uploads: [...state.uploads, ...uploads] }),
      rejected: ({ notices }) => ({ ...state, notices: [...state.notices, ...notices] }),
      removed: ({ removed }) => ({ ...state, removed }),
      undoExpired: () => withoutRemoved(state),
      undone: () => withoutRemoved(state),
      uploaded: ({ key }) => ({ ...state, uploads: state.uploads.filter((upload) => upload.key !== key) }),
      uploadFailed: ({ key, message }) => ({
        ...state,
        uploads: updateUpload(state, key, { message, phase: 'failed' }),
      }),
    }),
  );

/** The draft with a stored picture added at the end; a full gallery or a picture already in it stays as it is. */
export const withStaged = (images: readonly string[], image: string): readonly string[] =>
  images.includes(image) || images.length >= PRODUCT_GALLERY_LIMIT ? images : [...images, image];

/** The draft with one picture moved; position 0 is the main picture. */
export const withMoved = (images: readonly string[], from: number, to: number): readonly string[] =>
  moveImage(images, from, to);

/** The draft without `image`. */
export const withoutImage = (images: readonly string[], image: string): readonly string[] =>
  images.filter((entry) => entry !== image);

/** The draft with a removed picture back at its place. */
export const withRestored = (images: readonly string[], removed: RemovedImage): readonly string[] =>
  Option.getOrElse(restoreImage(images, removed.image, removed.position), () => images);

/** Translates a gallery copy key (`merchandise.pages.products.gallery.*`) with its values. */
export type GalleryTranslate = (key: string, values?: Readonly<Record<string, number | string>>) => string;

/** The person's message for one file the picker refused (Zag file-upload error codes). */
export const rejectionMessage = (
  t: GalleryTranslate,
  name: string,
  errors: readonly string[],
  remaining: number,
): string => {
  if (errors.includes('TOO_MANY_FILES')) {
    return remaining === 0
      ? t('merchandise.pages.products.gallery.galleryFull', { limit: PRODUCT_GALLERY_LIMIT })
      : t('merchandise.pages.products.gallery.tooManyFiles', { limit: PRODUCT_GALLERY_LIMIT, remaining });
  }
  if (errors.includes('FILE_TOO_LARGE')) {
    return t('merchandise.pages.products.gallery.fileTooLarge', { name });
  }
  if (errors.includes('FILE_INVALID_TYPE')) {
    return t('merchandise.pages.products.gallery.fileInvalidType', { name });
  }
  return t('merchandise.pages.products.gallery.fileRejected', { name });
};
