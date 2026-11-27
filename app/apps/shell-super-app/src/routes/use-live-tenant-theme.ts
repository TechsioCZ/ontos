import { Effect, Fiber } from 'effect';
import { useEffect, useState } from 'react';

import { TENANT_THEME_CHANGED_EVENT } from '../api/tenant-theme-events.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { businessShellTheme, readShellTheme } from './tenant-theme.ts';
import type { ShellTheme } from './tenant-theme.ts';

/** How often an open, visible signed-in Shell asks whether its tenant's theme changed. */
const REFRESH_INTERVAL = '15 seconds';

interface FreshTheme {
  /** The revision of the page model this read replaced; a newer page model brings its own theme. */
  readonly loadedRevision: string;
  readonly theme: ShellTheme;
}

const shownTheme = (loaded: ShellTheme | undefined, fresh: FreshTheme | undefined): ShellTheme => {
  if (loaded === undefined) {
    return businessShellTheme;
  }
  return fresh?.loadedRevision === loaded.revision ? fresh.theme : loaded;
};

/** Reads the tenant's theme on every trigger and reports a revision other than the one on screen. */
const watchTenantTheme = (shownRevision: string, onChange: (theme: ShellTheme) => void) => {
  const refresh = readShellTheme().pipe(
    Effect.matchEffect({
      // The theme on screen stays until a read succeeds; the next trigger asks again.
      onFailure: (error) => Effect.logDebug('The tenant theme could not be read', error),
      onSuccess: (theme) =>
        Effect.sync(() => {
          if (theme.revision !== shownRevision) {
            onChange(theme);
          }
        }),
    }),
  );
  const refreshWhenVisible = Effect.suspend(() => (document.visibilityState === 'visible' ? refresh : Effect.void));
  const polling = browserRuntime.runFork(
    Effect.sleep(REFRESH_INTERVAL).pipe(Effect.andThen(refreshWhenVisible), Effect.forever),
  );
  const onFocus = () => {
    void browserRuntime.runPromise(refresh);
  };
  const onVisibilityChange = () => {
    void browserRuntime.runPromise(refreshWhenVisible);
  };
  window.addEventListener('focus', onFocus);
  window.addEventListener(TENANT_THEME_CHANGED_EVENT, onFocus);
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    void browserRuntime.runPromise(Fiber.interrupt(polling));
    window.removeEventListener('focus', onFocus);
    window.removeEventListener(TENANT_THEME_CHANGED_EVENT, onFocus);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
};

/** Nothing to watch without a session: the page shows Business. */
const unwatched = () => {
  // A page without a session reads no tenant theme.
};

/**
 * The theme an open Shell shows, kept fresh without a reload. `loaded` is the theme the current page model carries
 * (none without a session). While signed in, the Shell reads the tenant's theme again when the window regains focus
 * or becomes visible, every 15 seconds while visible, and at once after a save or attach made in this browser; a new
 * revision replaces the shown theme until the next page model brings its own.
 */
export const useLiveTenantTheme = (loaded: ShellTheme | undefined): ShellTheme => {
  const [fresh, setFresh] = useState<FreshTheme>();
  const shown = shownTheme(loaded, fresh);
  const loadedRevision = loaded?.revision;

  useEffect(
    () =>
      loadedRevision === undefined
        ? unwatched
        : watchTenantTheme(shown.revision, (theme) => setFresh({ loadedRevision, theme })),
    [loadedRevision, shown.revision],
  );

  return shown;
};
