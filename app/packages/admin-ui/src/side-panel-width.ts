import { Option, Schema } from 'effect';

export const SIDE_PANEL_WIDTH_KEY = 'ontos:side-panel-width:v1';

const widthSchema = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0));

export const decodePanelWidth = (value: string | null): number | undefined =>
  value === null ? undefined : Option.getOrUndefined(Schema.decodeOption(widthSchema)(value));

/** Keep the panel on screen, including when the viewport is narrower than its minimum. */
export const clampPanelWidth = (width: number, minimum: number, viewport: number): number =>
  Math.round(Math.min(Math.max(width, Math.min(minimum, viewport)), viewport));

export const draggedPanelWidth = (startWidth: number, startX: number, currentX: number): number =>
  startWidth + startX - currentX;

/** Storage can be unavailable in private or restricted browser contexts. Resizing still works. */
export const readPanelWidth = (): number | undefined => {
  try {
    return decodePanelWidth(globalThis.localStorage.getItem(SIDE_PANEL_WIDTH_KEY));
  } catch {
    return undefined;
  }
};

export const savePanelWidth = (width?: number): boolean => {
  try {
    if (width === undefined) {
      globalThis.localStorage.removeItem(SIDE_PANEL_WIDTH_KEY);
    } else {
      globalThis.localStorage.setItem(SIDE_PANEL_WIDTH_KEY, String(width));
    }
    globalThis.dispatchEvent(new Event(SIDE_PANEL_WIDTH_KEY));
    return true;
  } catch {
    // The hook keeps the current width in visual state when browser storage is blocked.
    return false;
  }
};

export const subscribePanelWidth = (notify: () => void): (() => void) => {
  globalThis.addEventListener(SIDE_PANEL_WIDTH_KEY, notify);
  globalThis.addEventListener('storage', notify);
  return () => {
    globalThis.removeEventListener(SIDE_PANEL_WIDTH_KEY, notify);
    globalThis.removeEventListener('storage', notify);
  };
};

export const serverPanelWidth = (): undefined => undefined;
