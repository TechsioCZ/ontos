import { moduleWriteEvent } from '@app/shared-contracts/page-data';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { rootRouteId, useRouter, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import type { AnyRoute } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Fiber } from 'effect';
import { createContext, createElement, Suspense, useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';

import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { awaitPrimaryModuleReads, forgetRecordedPageReads, withoutRecordedPageReads } from './browser-request-cache.ts';

export const StaffRoutePreloadContext = createContext({ enabled: false, generation: 0 });

interface PreloadableNavigationItem {
  readonly enabled: boolean;
  readonly href?: string;
}

/** Long enough for a preloaded route chunk to resolve its lazy component. */
const LAZY_WARM_WINDOW = '2 seconds';
const ignoreRenderError = () => {
  // The warm-up render is expected to fail once the component needs its route context.
};

/**
 * Route components are `React.lazy`. A lazy component that has never rendered suspends on its first render even
 * when its chunk is loaded, and React holds a suspended transition for its 300 ms reveal throttle, so the first
 * navigation into each route showed the previous page for about 300 ms. Rendering each route component once,
 * detached from the document, resolves its lazy payload ahead of time. The render then fails without route context
 * (no effects run) and the root is discarded.
 */
const warmLazyRouteComponents = (components: readonly ComponentType[]) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      components.map((component) => {
        const root = createRoot(document.createElement('div'), {
          onCaughtError: ignoreRenderError,
          onRecoverableError: ignoreRenderError,
          onUncaughtError: ignoreRenderError,
        });
        root.render(createElement(Suspense, { fallback: null }, createElement(component)));
        return root;
      }),
    ),
    () => Effect.sleep(LAZY_WARM_WINDOW),
    (roots) => Effect.forEach(roots, (root) => Effect.sync(() => root.unmount()), { concurrency: 1, discard: true }),
  );

/** Components of the page routes the menu and Home lead to: they read route data first and fail at once. */
const pageRouteComponents = (router: ReturnType<typeof useRouter>, language: string, hrefs: string) => {
  const routeIds = new Set<string>(
    ['', ...hrefs.split('\n')].flatMap((href) =>
      router.matchRoutes(`/${language}${href}`).map(({ routeId }) => routeId),
    ),
  );
  routeIds.delete(rootRouteId);
  const routes: readonly (readonly [string, AnyRoute])[] = Object.entries(router.routesById);
  return routes.flatMap(([routeId, route]): ComponentType[] => {
    const component: ComponentType | undefined = route.options.component;
    return routeIds.has(routeId) && component !== undefined ? [component] : [];
  });
};

const warmDestinations = (router: ReturnType<typeof useRouter>, language: string, hrefs: string) =>
  Effect.forEach(
    hrefs === '' ? [] : hrefs.split('\n'),
    (href) => withoutRecordedPageReads(() => router.preloadRoute({ to: `/${language}${href}` })).pipe(Effect.ignore),
    { concurrency: 64, discard: true },
  );

/**
 * Native render preloads prepare code AND declared data concurrently. The only gate is the current page:
 * first let its loader settle and its already-issued primary reads finish, without an idle timer or dwell.
 */
export const useIdleRoutePreload = (
  navigation: readonly PreloadableNavigationItem[],
  contextKey: string,
  disabled: boolean,
) => {
  const router = useRouter();
  const { language } = useModernI18n();
  const currentHref = useRouterState({ select: ({ location }) => location.href });
  const settledHref = useRouterState({ select: ({ resolvedLocation }) => resolvedLocation?.href });
  const [preparedKey, setPreparedKey] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const previousContext = useRef(contextKey);
  const key = [contextKey, currentHref, generation].join('\n');
  const hrefs = navigation.flatMap((item) => (item.enabled && item.href !== undefined ? [item.href] : [])).join('\n');

  useEffect(() => {
    const restart = () => {
      router.clearCache();
      setGeneration((previous) => previous + 1);
    };
    globalThis.addEventListener(moduleWriteEvent, restart);
    return () => globalThis.removeEventListener(moduleWriteEvent, restart);
  }, [router]);

  useEffect(() => {
    if (previousContext.current !== contextKey) {
      previousContext.current = contextKey;
      router.clearCache();
      browserRuntime.runSync(forgetRecordedPageReads);
    }
  }, [contextKey, router]);

  useEffect(() => {
    if (disabled || currentHref !== settledHref || language === undefined) {
      return () => {
        // Nothing was started while the foreground page or context transition owns priority.
      };
    }
    const fiber = browserRuntime.runFork(
      awaitPrimaryModuleReads.pipe(
        Effect.flatMap((ready) =>
          ready
            ? Effect.sync(() => setPreparedKey(key)).pipe(
                Effect.andThen(
                  Effect.all(
                    [
                      Effect.suspend(() => warmLazyRouteComponents(pageRouteComponents(router, language, hrefs))),
                      warmDestinations(router, language, hrefs),
                    ],
                    { concurrency: 2, discard: true },
                  ),
                ),
              )
            : Effect.void,
        ),
      ),
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [currentHref, disabled, hrefs, key, language, router, settledHref]);

  return {
    enabled: !disabled && currentHref === settledHref && preparedKey === key,
    generation,
    suspend: () => {
      router.clearCache();
      browserRuntime.runSync(forgetRecordedPageReads);
    },
  };
};
