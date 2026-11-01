// State of the product gallery editor: the saved gallery as the server last confirmed it, the order the person sees
// (optimistic), the uploads in flight and the one removal that can still be undone. Pure, so every state is testable.
import { Match, Schema } from 'effect';
import { moveImage } from '../../../../../shared/domain/product-images.ts';

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

export const SaveStatusSchema = Schema.Literals(['error', 'idle', 'saved', 'saving']);
export type SaveStatus = typeof SaveStatusSchema.Type;

export interface GalleryState {
  readonly images: readonly string[];
  readonly notices: readonly GalleryNotice[];
  readonly removed?: { readonly image: string; readonly position: number };
  readonly saved: readonly string[];
  readonly status: SaveStatus;
  readonly uploads: readonly PendingUpload[];
}

export type GalleryEvent =
  | { readonly images: readonly string[]; readonly type: 'server' }
  | { readonly from: number; readonly to: number; readonly type: 'move' }
  | { readonly image: string; readonly type: 'remove' }
  | { readonly type: 'undo' }
  | { readonly type: 'undoExpired' }
  | { readonly type: 'saved' }
  | { readonly message: string; readonly type: 'saveFailed' }
  | { readonly type: 'queued'; readonly uploads: readonly PendingUpload[] }
  | { readonly key: string; readonly phase: UploadPhase; readonly type: 'phase' }
  | { readonly key: string; readonly message: string; readonly type: 'uploadFailed' }
  | { readonly image: string; readonly key: string; readonly type: 'uploaded' }
  | { readonly key: string; readonly type: 'dismissUpload' }
  | { readonly notices: readonly GalleryNotice[]; readonly type: 'rejected' }
  | { readonly key: string; readonly type: 'dismissNotice' };

export const initialGallery = (images: readonly string[]): GalleryState => ({
  images,
  notices: [],
  saved: images,
  status: 'idle',
  uploads: [],
});

const sameOrder = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((image, index) => image === right[index]);

/** Uploads still waiting for their turn or on the wire; a failed one only waits for the person. */
export const activeUploads = (state: GalleryState) => state.uploads.filter((upload) => upload.phase !== 'failed');

const withoutRemoved = ({ removed: _removed, ...rest }: GalleryState): GalleryState => rest;

const restoreRemoved = (state: GalleryState): GalleryState => {
  if (state.removed === undefined) {
    return state;
  }
  const { image, position } = state.removed;
  const at = Math.min(position, state.images.length);
  return {
    ...withoutRemoved(state),
    images: [...state.images.slice(0, at), image, ...state.images.slice(at)],
    status: 'saving',
  };
};

const removeFromGallery = (state: GalleryState, image: string): GalleryState => {
  const position = state.images.indexOf(image);
  return position === -1
    ? state
    : {
        ...state,
        images: state.images.filter((entry) => entry !== image),
        removed: { image, position },
        status: 'saving',
      };
};

const withUploaded = (state: GalleryState, image: string, key: string): GalleryState => ({
  ...state,
  images: state.images.includes(image) ? state.images : [...state.images, image],
  saved: state.saved.includes(image) ? state.saved : [...state.saved, image],
  status: 'saved',
  uploads: state.uploads.filter((upload) => upload.key !== key),
});

const updateUpload = (state: GalleryState, key: string, change: Partial<PendingUpload>) =>
  state.uploads.map((upload) => (upload.key === key ? { ...upload, ...change } : upload));

export const galleryReducer = (state: GalleryState, event: GalleryEvent): GalleryState =>
  Match.value(event).pipe(
    Match.discriminatorsExhaustive('type')({
      dismissNotice: ({ key }) => ({ ...state, notices: state.notices.filter((notice) => notice.key !== key) }),
      dismissUpload: ({ key }) => ({ ...state, uploads: state.uploads.filter((upload) => upload.key !== key) }),
      move: ({ from, to }) => {
        const images = moveImage(state.images, from, to);
        return images === state.images ? state : { ...state, images, status: 'saving' as const };
      },
      phase: ({ key, phase }) => ({
        ...state,
        status: phase === 'uploading' ? 'saving' : state.status,
        uploads: updateUpload(state, key, { phase }),
      }),
      queued: ({ uploads }) => ({ ...state, uploads: [...state.uploads, ...uploads] }),
      rejected: ({ notices }) => ({ ...state, notices: [...state.notices, ...notices] }),
      remove: ({ image }) => removeFromGallery(state, image),
      saved: () => ({ ...state, saved: state.images, status: 'saved' as const }),
      saveFailed: ({ message }) => ({
        ...state,
        images: state.saved,
        notices: [...state.notices, { key: `save-${state.notices.length}`, message }],
        status: 'error' as const,
      }),
      // A fresh read wins unless the person's own change is still being saved.
      server: ({ images }) =>
        state.status === 'saving' || sameOrder(state.saved, images)
          ? { ...state, saved: images }
          : { ...state, images, saved: images },
      undo: () => restoreRemoved(state),
      undoExpired: () => withoutRemoved(state),
      uploaded: ({ image, key }) => withUploaded(state, image, key),
      uploadFailed: ({ key, message }) => ({
        ...state,
        status: 'error' as const,
        uploads: updateUpload(state, key, { message, phase: 'failed' }),
      }),
    }),
  );

/** Czech message for one file the picker refused (Zag file-upload error codes). */
export const rejectionMessage = (name: string, errors: readonly string[], remaining: number): string => {
  if (errors.includes('TOO_MANY_FILES')) {
    return remaining === 0
      ? 'Produkt už má 20 obrázků, další přidat nelze. Nejdřív některý odeberte.'
      : `Produkt může mít nejvýše 20 obrázků. Teď můžete přidat ještě ${remaining}.`;
  }
  if (errors.includes('FILE_TOO_LARGE')) {
    return `Soubor „${name}“ je větší než 20 MB. Zmenšete ho, nebo vyberte jiný.`;
  }
  if (errors.includes('FILE_INVALID_TYPE')) {
    return `Soubor „${name}“ není obrázek ve formátu JPG, PNG nebo WebP.`;
  }
  return `Soubor „${name}“ nelze nahrát.`;
};
