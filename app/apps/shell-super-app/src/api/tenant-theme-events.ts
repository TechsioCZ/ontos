import { Effect } from 'effect';

/** Fired in this browser after a theme save or attach succeeded, so the open Shell reads its theme at once. */
export const TENANT_THEME_CHANGED_EVENT = 'ontos:tenant-theme-changed';

export const announceTenantThemeChange = Effect.sync(() => {
  if ('window' in globalThis) {
    globalThis.window.dispatchEvent(new Event(TENANT_THEME_CHANGED_EVENT));
  }
});
