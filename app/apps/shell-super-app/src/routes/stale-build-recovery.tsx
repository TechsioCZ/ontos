import { ErrorComponent, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Clock, Option, Ref, Schema, flow } from 'effect';
import { browserRuntime } from '../runtime/browser-effect-runtime';

// A deploy replaces every hashed chunk, so a document opened before it asks for files that no longer exist.
// The fix is a fresh document of the same URL; one automatic reload per 30 s keeps a real outage from looping.
const reloadGuardKey = 'ontos:stale-build-reload-at';
const reloadGuardMs = 30_000;

const chunkFailurePattern =
  /ChunkLoadError|Loading (?:CSS )?chunk [^ ]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Federation Runtime|RUNTIME-00[0-9]/iu;

const ChunkFailureSchema = Schema.Union([
  Schema.String,
  Schema.Struct({ message: Schema.optionalKey(Schema.String), name: Schema.optionalKey(Schema.String) }),
]);

/** Parse the error value at the router/browser boundary before inspecting its text. */
export const isChunkLoadFailure = flow(
  Schema.decodeUnknownOption(ChunkFailureSchema),
  Option.match({
    onNone: () => false,
    onSome: (description) =>
      chunkFailurePattern.test(
        Schema.is(Schema.String)(description) ? description : `${description.name ?? ''} ${description.message ?? ''}`,
      ),
  }),
);

const recoveryState = browserRuntime.runSync(Ref.make({ installed: false, staleBuild: false }));

const editingNow = (): boolean => {
  const active = globalThis.document?.activeElement;
  return (
    Schema.is(Schema.instanceOf(HTMLElement))(active) &&
    (active.isContentEditable || active.matches('input, textarea, select'))
  );
};

/** Loads `href` (default: the current URL) as a fresh document unless this tab already did so within the guard window. True when it started. */
export const reloadOnceForStaleBuild = (href?: string): boolean => {
  const now = browserRuntime.runSync(Clock.currentTimeMillis);
  try {
    const last = Number(globalThis.sessionStorage.getItem(reloadGuardKey) ?? '0');
    if (Number.isFinite(last) && now - last < reloadGuardMs) {
      return false;
    }
    globalThis.sessionStorage.setItem(reloadGuardKey, String(now));
  } catch {
    // Storage unavailable: still recover once; a loop is bounded by the browser's own reload cost.
  }
  if (href === undefined) {
    globalThis.location.reload();
  } else {
    globalThis.location.assign(href);
  }
  return true;
};

/** Reloads now, or on the next navigation while the person is typing, so a background preload never drops a form. */
export const recoverFromStaleBuild = (): void => {
  if (editingNow()) {
    browserRuntime.runSync(Ref.update(recoveryState, (state) => ({ ...state, staleBuild: true })));
    return;
  }
  reloadOnceForStaleBuild();
};

const reloadNow = () => {
  globalThis.location.reload();
};

/** The route error screen: a stale chunk reloads the page once, anything else keeps the router's error screen. */
export const StaleBuildAwareErrorComponent = (props: ErrorComponentProps) => {
  const chunkFailure = isChunkLoadFailure(props.error);
  useEffect(() => {
    if (chunkFailure) {
      reloadOnceForStaleBuild();
    }
  }, [chunkFailure]);
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
  // A chunk failed earlier while the person was typing: the next navigation loads its target as a fresh document.
  useEffect(() => {
    router.update({ defaultErrorComponent: StaleBuildAwareErrorComponent });
    return router.subscribe('onBeforeNavigate', (event) => {
      if (browserRuntime.runSync(Ref.get(recoveryState)).staleBuild) {
        reloadOnceForStaleBuild(event.toLocation.href);
      }
    });
  }, [router]);
};

/** Chunk or remote loads that fail outside a route boundary (lazy imports, preloads) also recover once. */
export const installStaleBuildRecovery = (): void => {
  const previous = browserRuntime.runSync(Ref.getAndUpdate(recoveryState, (state) => ({ ...state, installed: true })));
  if (previous.installed) {
    return;
  }
  globalThis.addEventListener('unhandledrejection', (event) => {
    if (isChunkLoadFailure(event.reason)) {
      recoverFromStaleBuild();
    }
  });
  globalThis.addEventListener('error', (event) => {
    if (isChunkLoadFailure(event.error)) {
      recoverFromStaleBuild();
    }
  });
};
