import { ErrorComponent, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

// A deploy replaces every hashed chunk, so a document opened before it asks for files that no longer exist.
// The fix is a fresh document of the same URL; one automatic reload per 30 s keeps a real outage from looping.
const reloadGuardKey = 'ontos:stale-build-reload-at';
const reloadGuardMs = 30_000;

const chunkFailurePattern =
  /ChunkLoadError|Loading (?:CSS )?chunk [^ ]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Federation Runtime|RUNTIME-00[0-9]|remoteEntry/iu;

export const isChunkLoadFailure = (error: unknown): boolean => {
  if (error === null || error === undefined) {
    return false;
  }
  const candidate = error as { readonly message?: unknown; readonly name?: unknown };
  const text = `${String(candidate.name ?? '')} ${String(candidate.message ?? (typeof error === 'string' ? error : ''))}`;
  return chunkFailurePattern.test(text);
};

/** Reloads the current URL unless this tab already did so within the guard window. True when a reload started. */
export const reloadOnceForStaleBuild = (): boolean => {
  const now = Date.now();
  try {
    const last = Number(globalThis.sessionStorage.getItem(reloadGuardKey) ?? '0');
    if (Number.isFinite(last) && now - last < reloadGuardMs) {
      return false;
    }
    globalThis.sessionStorage.setItem(reloadGuardKey, String(now));
  } catch {
    // Storage unavailable: still recover once; a loop is bounded by the browser's own reload cost.
  }
  globalThis.location.reload();
  return true;
};

const reloadNow = () => {
  globalThis.location.reload();
};

/** The route error screen: a stale chunk reloads the page once, anything else keeps the router's error screen. */
export const StaleBuildAwareErrorComponent = (props: ErrorComponentProps) => {
  const chunkFailure = isChunkLoadFailure(props.error);
  const [reloading, setReloading] = useState(chunkFailure);
  useEffect(() => {
    if (chunkFailure) {
      setReloading(reloadOnceForStaleBuild());
    }
  }, [chunkFailure]);
  if (reloading) {
    return null;
  }
  return (
    <div style={{ display: 'grid', gap: '0.75rem', justifyItems: 'start', padding: '1rem' }}>
      <ErrorComponent {...props} />
      <button
        onClick={reloadNow}
        style={{
          border: '1px solid currentColor',
          borderRadius: '0.375rem',
          fontWeight: 600,
          padding: '0.4rem 0.9rem',
        }}
        type="button"
      >
        Načíst znovu
      </button>
    </div>
  );
};

/** Makes every route without its own error component use the stale-build aware one. */
export const useStaleBuildErrorRecovery = (): void => {
  const router = useRouter();
  if (router.options.defaultErrorComponent !== StaleBuildAwareErrorComponent) {
    router.options.defaultErrorComponent = StaleBuildAwareErrorComponent;
  }
};

let installed = false;

/** Chunk or remote loads that fail outside a route boundary (lazy imports, preloads) also recover once. */
export const installStaleBuildRecovery = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  globalThis.addEventListener('unhandledrejection', (event) => {
    if (isChunkLoadFailure(event.reason) && reloadOnceForStaleBuild()) {
      event.preventDefault();
    }
  });
  globalThis.addEventListener('error', (event) => {
    if (isChunkLoadFailure(event.error) && reloadOnceForStaleBuild()) {
      event.preventDefault();
    }
  });
};
