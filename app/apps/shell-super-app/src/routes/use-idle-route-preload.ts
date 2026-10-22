import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { rootRouteId, useRouter, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import type { AnyRoute } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Fiber } from 'effect';
import { createElement, Suspense, useEffect } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';

import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { canonicalPathFromRequest } from './[lang]/canonical-page-model.ts';
import { loadModulePageModel } from './[lang]/modules/[moduleId]/module-page-model.ts';
import { awaitModuleTrafficQuiet, recordedReadAudiences, warmGatewayAssertions } from './browser-request-cache.ts';
import { loadRemotePage } from './remote-page-loader.ts';

interface PreloadableNavigationItem {
  readonly appId?: string;
  readonly enabled: boolean;
  readonly href?: string;
}

/** Finish the foreground page's owner reads before speculative menu traffic starts. */
const SETTLE_DELAY = '5 seconds';
const DESTINATION_WARM_CONCURRENCY = 1;
/** Shell pages of the platform layer: not module targets, so idle warming has nothing to resolve for them. */
const SHELL_APP_ID = 'shell-super-app';
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
 * Warms one module destination of the menu: resolves its target (kept by the browser target cache) and loads its
 * remote page module. Unlike a route preload it does not repeat the page's remembered reads: those are owner reads
 * (gateway, SpiceDB, database) for pages the person may never open, about twenty per document across the menu. A
 * click then only waits for the page's own reads; a hover (intent preload) still prefetches them.
 */
const warmModuleDestination = (language: string, href: string) => {
  const request = new Request(new URL(`/${encodeURIComponent(language)}${href}`, globalThis.location.href));
  const canonicalPath = canonicalPathFromRequest(request, language);
  return canonicalPath === undefined
    ? Effect.void
    : loadModulePageModel({ canonicalPath, request }).pipe(
        Effect.flatMap((model) => (model.state === 'resolved' ? loadRemotePage(model.target) : Effect.void)),
        Effect.timeout('30 seconds'),
        Effect.ignore,
      );
};

/**
 * Once a navigation has settled and the page's own module traffic is quiet, issues gateway assertions for every
 * module in the menu (and every module a remembered page read), warms every enabled module destination (target and
 * remote page module) and resolves the lazy route components, all in parallel. Targets and remote page modules are
 * cached for the document, so repeated navigations warm from memory.
 */
export const useIdleRoutePreload = (navigation: readonly PreloadableNavigationItem[]) => {
  const router = useRouter();
  const { language } = useModernI18n();
  const settledPath = useRouterState({ select: ({ resolvedLocation }) => resolvedLocation?.pathname });
  const hrefs = navigation.flatMap((item) => (item.enabled && item.href !== undefined ? [item.href] : [])).join('\n');
  const moduleHrefs = navigation
    .flatMap((item) =>
      item.enabled && item.href !== undefined && item.appId !== undefined && item.appId !== SHELL_APP_ID
        ? [item.href]
        : [],
    )
    .join('\n');
  const modules = [...new Set(navigation.flatMap((item) => (item.appId === undefined ? [] : [item.appId])))].join('\n');

  useEffect(() => {
    const warmAssertions = recordedReadAudiences.pipe(
      Effect.flatMap((recorded) =>
        warmGatewayAssertions([...new Set([...modules.split('\n'), ...recorded])].filter((id) => id.length > 0)),
      ),
    );
    const warmDestinations = Effect.forEach(
      moduleHrefs.split('\n').filter((href) => href.length > 0),
      (href) => warmModuleDestination(language ?? '', href),
      { concurrency: DESTINATION_WARM_CONCURRENCY, discard: true },
    );
    const warmRoutes = Effect.suspend(() => warmLazyRouteComponents(pageRouteComponents(router, language, hrefs)));
    const fiber =
      __ONTOS_BROWSER_BUILD__ && settledPath !== undefined && language !== undefined
        ? browserRuntime.runFork(
            Effect.sleep(SETTLE_DELAY).pipe(
              Effect.andThen(awaitModuleTrafficQuiet),
              Effect.andThen(
                Effect.all([warmAssertions, warmDestinations, warmRoutes], {
                  concurrency: 3,
                  discard: true,
                }),
              ),
            ),
          )
        : undefined;
    return () => {
      if (fiber !== undefined) {
        browserRuntime.runFork(Fiber.interrupt(fiber));
      }
    };
  }, [hrefs, language, moduleHrefs, modules, router, settledPath]);
};
