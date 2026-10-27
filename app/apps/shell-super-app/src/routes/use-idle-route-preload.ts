import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { rootRouteId, useRouter, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import type { AnyRoute } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Fiber } from 'effect';
import { createElement, Suspense, useEffect } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';

import type { ShellNavigationItem } from '../../shared/api.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { awaitModuleTrafficQuiet } from './browser-request-cache.ts';
import { loadRemotePage } from './remote-page-loader.ts';

interface PreloadableNavigationItem {
  readonly enabled: boolean;
  readonly href?: string;
  readonly remote?: ShellNavigationItem['remote'];
}

/** Let the foreground page load its own chunks first. */
const SETTLE_DELAY = '5 seconds';
/** Remote containers loaded at once while idle. */
const REMOTE_WARM_CONCURRENCY = 3;
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

/**
 * Code only: loads the remote page module of every enabled menu destination, so opening one waits only for its
 * data. Each item carries its remote from the composition, so this reads nothing (no API, assertion or module read)
 * and runs no `preloadPage`.
 */
const warmRemotePages = (compositionRevision: string, navigation: readonly PreloadableNavigationItem[]) =>
  Effect.forEach(
    navigation.flatMap((item) => (item.enabled && item.remote !== undefined ? [item.remote] : [])),
    (federation) => loadRemotePage({ compositionRevision, federation }),
    { concurrency: REMOTE_WARM_CONCURRENCY, discard: true },
  );

/**
 * Shortly after each navigation settles and module traffic goes quiet, resolves the Shell's own lazy route components
 * for the menu destinations and loads their remote page code. It never runs route loaders or calls an API: resolving
 * a module target, issuing a gateway assertion, preparing a page's data or prefetching its reads happens only for the
 * page being opened or on hover/focus intent (`ShellRouteLink` preloads on intent). Idle warming of every menu
 * destination used to issue about 50 Shell and owner requests per page view, which multiplied the load on a
 * pool-bound Shell.
 */
export const useIdleRoutePreload = (
  navigation: readonly PreloadableNavigationItem[],
  compositionRevision: string | undefined,
) => {
  const router = useRouter();
  const { language } = useModernI18n();
  const settledPath = useRouterState({ select: ({ resolvedLocation }) => resolvedLocation?.pathname });
  const hrefs = navigation.flatMap((item) => (item.enabled && item.href !== undefined ? [item.href] : [])).join('\n');

  useEffect(() => {
    const fiber =
      settledPath !== undefined && language !== undefined
        ? browserRuntime.runFork(
            Effect.sleep(SETTLE_DELAY).pipe(
              Effect.andThen(awaitModuleTrafficQuiet),
              Effect.andThen(
                Effect.all(
                  [
                    Effect.suspend(() => warmLazyRouteComponents(pageRouteComponents(router, language, hrefs))),
                    compositionRevision === undefined
                      ? Effect.void
                      : Effect.suspend(() => warmRemotePages(compositionRevision, navigation)),
                  ],
                  { concurrency: 2, discard: true },
                ),
              ),
            ),
          )
        : undefined;
    return () => {
      if (fiber !== undefined) {
        browserRuntime.runFork(Fiber.interrupt(fiber));
      }
    };
  }, [compositionRevision, hrefs, language, navigation, router, settledPath]);
};
