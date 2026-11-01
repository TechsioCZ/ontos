import { moduleWriteEvent } from '@app/shared-contracts/page-data';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { rootRouteId, useRouter, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import type { AnyRoute } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Fiber } from 'effect';
import { createContext, createElement, Suspense, useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';

import { isModuleDestination } from '../../shared/shell-platform-navigation.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { prepareCanonicalTargets } from './[lang]/modules/[moduleId]/module-page-model.ts';
import { awaitPrimaryModuleReads, forgetRecordedPageReads, withoutRecordedPageReads } from './browser-request-cache.ts';
import { useLiveChanges } from './live-changes.ts';
import { staffRoutePreloads } from './route-preload-scheduler.ts';

export const StaffRoutePreloadContext = createContext({ enabled: false, generation: 0 });

interface PreloadableNavigationItem {
  readonly appId?: string | undefined;
  readonly enabled: boolean;
  readonly href?: string;
}

/** Long enough for a preloaded route chunk to resolve its lazy component. */
const LAZY_WARM_WINDOW = '2 seconds';
/** How long writes must pause before the menu prefetch starts over. */
const PREFETCH_RESTART_QUIET = '20 seconds';
const ignoreRenderError = () => {
  // The warm-up render is expected to fail once the component needs its route context.
};

/** Keep one measurement per phase, so long-lived staff sessions do not accumulate navigation marks. */
const markPreparation = (name: string, href: string) =>
  Effect.sync(() => {
    performance.clearMarks(name);
    performance.mark(name, { detail: { href } });
  });

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

const preloadDestinations = (router: ReturnType<typeof useRouter>, language: string, hrefs: readonly string[]) =>
  Effect.forEach(
    hrefs,
    (href) =>
      staffRoutePreloads.schedule(
        `/${language}${href}`,
        'background',
        withoutRecordedPageReads(() => router.preloadRoute({ to: `/${language}${href}` })).pipe(Effect.ignore),
      ),
    { concurrency: 64, discard: true },
  );

/**
 * Module destinations first get their page targets in one request (instead of one each), then load like the Shell's
 * own pages, which start at once. A failed batch only means each module loader resolves its own target.
 */
const warmDestinations = (
  router: ReturnType<typeof useRouter>,
  language: string,
  hrefs: string,
  moduleHrefs: string,
) => {
  const destinations = hrefs === '' ? [] : hrefs.split('\n');
  const modules = new Set(moduleHrefs === '' ? [] : moduleHrefs.split('\n'));
  const [first] = modules;
  return Effect.all(
    [
      preloadDestinations(
        router,
        language,
        destinations.filter((href) => !modules.has(href)),
      ),
      (first === undefined
        ? Effect.void
        : prepareCanonicalTargets(new Request(new URL(`/${language}${first}`, globalThis.location.href)), [
            ...modules,
          ]).pipe(Effect.ignore)
      ).pipe(Effect.andThen(preloadDestinations(router, language, [...modules]))),
    ],
    { concurrency: 2, discard: true },
  );
};

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
  // Changes committed elsewhere reach the pages shown under this company context without any reload.
  useLiveChanges(!disabled && navigation.some((item) => item.enabled && isModuleDestination(item)));
  const key = [contextKey, currentHref, generation].join('\n');
  const hrefs = navigation.flatMap((item) => (item.enabled && item.href !== undefined ? [item.href] : [])).join('\n');
  const moduleHrefs = navigation
    .flatMap((item) => (item.enabled && item.href !== undefined && isModuleDestination(item) ? [item.href] : []))
    .join('\n');

  useEffect(() => {
    // A write drops cached reads and the router cache at once, but the menu prefetch starts over only once the
    // writes are quiet: autosave writes every few seconds while someone types and must not re-read every module.
    let pending: Fiber.Fiber<void> | undefined;
    const prefetchAgain = Effect.sync(() => setGeneration((previous) => previous + 1));
    const restart = () => {
      browserRuntime.runSync(staffRoutePreloads.invalidate);
      router.clearCache();
      if (pending !== undefined) {
        browserRuntime.runFork(Fiber.interrupt(pending));
      }
      pending = browserRuntime.runFork(Effect.sleep(PREFETCH_RESTART_QUIET).pipe(Effect.andThen(prefetchAgain)));
    };
    globalThis.addEventListener(moduleWriteEvent, restart);
    return () => {
      globalThis.removeEventListener(moduleWriteEvent, restart);
      if (pending !== undefined) {
        browserRuntime.runFork(Fiber.interrupt(pending));
      }
    };
  }, [router]);

  useEffect(() => {
    if (previousContext.current !== contextKey) {
      previousContext.current = contextKey;
      browserRuntime.runSync(staffRoutePreloads.invalidate);
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
            ? markPreparation('ontos:visible-reads-complete', currentHref).pipe(
                Effect.andThen(staffRoutePreloads.resume),
                Effect.andThen(Effect.sync(() => setPreparedKey(key))),
                Effect.andThen(
                  Effect.all(
                    [
                      Effect.suspend(() => warmLazyRouteComponents(pageRouteComponents(router, language, hrefs))),
                      warmDestinations(router, language, hrefs, moduleHrefs),
                    ],
                    { concurrency: 2, discard: true },
                  ),
                ),
                Effect.andThen(staffRoutePreloads.awaitIdle),
                Effect.andThen(markPreparation('ontos:menu-prefetch-complete', currentHref)),
              )
            : Effect.void,
        ),
      ),
    );
    return () => {
      browserRuntime.runSync(staffRoutePreloads.pause);
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [currentHref, disabled, hrefs, key, language, moduleHrefs, router, settledHref]);

  return {
    enabled: !disabled && currentHref === settledHref && preparedKey === key,
    generation,
    suspend: () => {
      browserRuntime.runSync(staffRoutePreloads.invalidate);
      router.clearCache();
      browserRuntime.runSync(forgetRecordedPageReads);
    },
  };
};
