import { Option, Schema } from 'effect';
import { useState, useSyncExternalStore } from 'react';

export const DETAIL_VIEW_MODE_KEY = 'ontos:detail-view-mode:v1';

export const DetailViewModeSchema = Schema.Literals(['page', 'panel']);
export type DetailViewMode = typeof DetailViewModeSchema.Type;

/** Full page is the default. A missing, unknown or unreadable value means the page. */
const defaultDetailViewMode: DetailViewMode = 'page';

export const decodeDetailViewMode = (value: string | null): DetailViewMode =>
  value === null
    ? defaultDetailViewMode
    : Option.getOrElse(Schema.decodeUnknownOption(DetailViewModeSchema)(value), () => defaultDetailViewMode);

/** Storage can be unavailable in private or restricted browser contexts. The default then applies. */
export const readDetailViewMode = (): DetailViewMode => {
  try {
    return decodeDetailViewMode(globalThis.localStorage.getItem(DETAIL_VIEW_MODE_KEY));
  } catch {
    return defaultDetailViewMode;
  }
};

export const saveDetailViewMode = (mode: DetailViewMode): boolean => {
  try {
    globalThis.localStorage.setItem(DETAIL_VIEW_MODE_KEY, mode);
    globalThis.dispatchEvent(new Event(DETAIL_VIEW_MODE_KEY));
    return true;
  } catch {
    // The hook keeps the chosen mode in visual state when browser storage is blocked.
    return false;
  }
};

const subscribeDetailViewMode = (notify: () => void): (() => void) => {
  globalThis.addEventListener(DETAIL_VIEW_MODE_KEY, notify);
  globalThis.addEventListener('storage', notify);
  return () => {
    globalThis.removeEventListener(DETAIL_VIEW_MODE_KEY, notify);
    globalThis.removeEventListener('storage', notify);
  };
};

const serverDetailViewMode = (): DetailViewMode => defaultDetailViewMode;

/**
 * Detail views of the list pages open as a full page by default, or in the side panel when the user chose that.
 * One choice is shared by every list and remembered per browser.
 */
export const useDetailViewMode = (): readonly [DetailViewMode, (next: DetailViewMode) => void] => {
  const stored = useSyncExternalStore(subscribeDetailViewMode, readDetailViewMode, serverDetailViewMode);
  const [unsaved, setUnsaved] = useState<DetailViewMode | null>(null);
  const mode = unsaved ?? stored;
  const setMode = (next: DetailViewMode) => {
    setUnsaved(saveDetailViewMode(next) ? null : next);
  };
  return [mode, setMode];
};
