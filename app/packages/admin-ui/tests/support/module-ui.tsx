// The real UI runtime of one OntOS module for component tests: the module's own i18next configuration and catalogs
// (its src/modern.runtime.ts), the Modern.js i18n context, federated i18n boundary and runtime component resolution,
// and a real TanStack router in memory history. Nothing here replaces a module or a global.
//
// pnpm installs the Modern.js runtime packages once per peer set, so a module's pages hold their own instances of the
// i18n and runtime React contexts. The module therefore passes its own provider components (see ModuleRuntimeBindings);
// a provider imported here would be a different context object than the one the page reads.
import type { FederatedI18nBoundary } from '@modern-js/i18n-integration/federation';
import { assertI18nInstance } from '@modern-js/plugin-i18n/i18n';
import type { I18nNavigationProvider } from '@modern-js/plugin-i18n/runtime';
import type { ModernI18nProvider } from '@modern-js/plugin-i18n/runtime/consumer';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
  useRouter,
} from '@modern-js/plugin-tanstack/runtime';
import type { AnyRouter } from '@modern-js/plugin-tanstack/runtime';
import type { RuntimeComponentResolverContext } from '@modern-js/runtime/context';
import { Duration, Effect, Schema } from 'effect';
import { flow } from 'effect/Function';
import { expect, rstest } from 'effect-rstest';
import { createInstance } from 'i18next';
import type { i18n } from 'i18next';
import { act, useSyncExternalStore } from 'react';
import type { ComponentProps, ContextType, ReactElement, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

const ModuleLanguageSchema = Schema.Literals(['cs', 'en']);
export type ModuleLanguage = typeof ModuleLanguageSchema.Type;

/** The copy a page installs through its own `FederatedI18nBoundary resources`, by language and namespace. */
export type PageResources = NonNullable<ComponentProps<typeof FederatedI18nBoundary>['resources']>;

/**
 * What a module hands the harness: the default export of its src/modern.runtime.ts and its own instances of the
 * framework providers its pages read. tests/support/module-ui.ts in each module binds them; copy that file unchanged.
 */
export interface ModuleRuntimeBindings {
  readonly FederatedI18nBoundary: typeof FederatedI18nBoundary;
  readonly I18nNavigationProvider: typeof I18nNavigationProvider;
  readonly ModernI18nProvider: typeof ModernI18nProvider;
  readonly RuntimeComponentResolverContext: typeof RuntimeComponentResolverContext;
  readonly runtimeConfig: unknown;
}

/** The i18n part of a module's production runtime configuration, read through its declared shape. */
const ModuleI18nOptions = Schema.Struct({
  i18n: Schema.Struct({
    initOptions: Schema.Struct({
      defaultNS: Schema.String,
      fallbackLng: Schema.String,
      ns: Schema.Array(Schema.String),
      resources: Schema.Record(
        Schema.String,
        Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
      ),
    }),
  }),
});

// React's own switch for tests that drive it through `act`, as React Testing Library sets it on import.
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

/** Lets the client Effects and requests the page started take a turn, then flushes React's updates. Needs `it.live`. */
export const settle: Effect.Effect<void> = Effect.sleep('1 millis').pipe(
  Effect.andThen(
    Effect.promise(async () => {
      await act(async () => {
        await Promise.resolve();
      });
    }),
  ),
);

/**
 * `settle` for a test under `rstest.useFakeTimers` (setTimeout, clearTimeout and Date faked), where `settle`'s own
 * sleep would wait for fake time: runs the fake timers already due and lets real work take a turn, then flushes
 * React's updates. No fake time passes.
 */
export const settleOnFakeTimers: Effect.Effect<void> = Effect.promise(async () => {
  await act(async () => {
    await rstest.advanceTimersByTimeAsync(0);
  });
});

/** Runs `step` inside React's `act`, then settles (with `settled`, e.g. `settleOnFakeTimers`; default `settle`). */
export const acted = (step: () => void, settled: Effect.Effect<void> = settle): Effect.Effect<void> =>
  Effect.sync(() => {
    act(step);
  }).pipe(Effect.andThen(settled));

/** Settles until the DOM or recorded data satisfy `condition`; fails when they never do. */
export const waitUntil = (condition: () => boolean, attempts = 400): Effect.Effect<void> =>
  Effect.suspend(() =>
    condition() || attempts === 0
      ? Effect.sync(() => {
          expect(condition()).toBe(true);
        })
      : settle.pipe(Effect.andThen(waitUntil(condition, attempts - 1))),
  );

/** `waitUntil` under fake timers: settles with `settleOnFakeTimers`, so no fake time passes while it waits. */
export const waitUntilOnFakeTimers = (condition: () => boolean, attempts = 400): Effect.Effect<void> =>
  Effect.suspend(() =>
    condition() || attempts === 0
      ? Effect.sync(() => {
          expect(condition()).toBe(true);
        })
      : settleOnFakeTimers.pipe(Effect.andThen(waitUntilOnFakeTimers(condition, attempts - 1))),
  );

/**
 * Lets `duration` of fake time pass under `rstest.useFakeTimers`, in `step`s (default one second) inside React's
 * `act`. After each step `between` runs (default `settleOnFakeTimers`); pass the network double's `networkIdle` so
 * the work a timer started finishes at the fake instant the timer fired, before more fake time passes.
 */
export const passFakeTime = (
  duration: Duration.Input,
  {
    between = settleOnFakeTimers,
    step = '1 second',
  }: { readonly between?: Effect.Effect<void>; readonly step?: Duration.Input } = {},
): Effect.Effect<void> => {
  const stepMillis = Duration.toMillis(Duration.fromInputUnsafe(step));
  const pass = (left: number): Effect.Effect<void> =>
    left <= 0
      ? Effect.void
      : Effect.promise(async () => {
          await act(async () => {
            await rstest.advanceTimersByTimeAsync(Math.min(stepMillis, left));
          });
        }).pipe(
          Effect.andThen(between),
          Effect.andThen(settleOnFakeTimers),
          Effect.andThen(Effect.suspend(() => pass(left - stepMillis))),
        );
  return pass(Duration.toMillis(Duration.fromInputUnsafe(duration)));
};

const unmounts: (() => void)[] = [];

/** Unmounts everything `mountInRoute` rendered; call it in `afterEach`. */
export const unmountAll = () => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
};

export const text = () => document.body.textContent ?? '';

export const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.textContent?.trim() === name || button.getAttribute('aria-label') === name,
  );

type ModuleI18nInit = (typeof ModuleI18nOptions.Type)['i18n']['initOptions'];

/** Real i18next with a module's production init options and catalogs, in `language`, plus a page's own copy. */
const makeCopy = (initOptions: ModuleI18nInit, language: ModuleLanguage, page: PageResources): i18n => {
  const instance = createInstance();
  void instance.init({
    defaultNS: initOptions.defaultNS,
    fallbackLng: initOptions.fallbackLng,
    initAsync: false,
    interpolation: { escapeValue: false },
    lng: language,
    ns: [...initOptions.ns],
    resources: initOptions.resources,
  });
  for (const [pageLanguage, namespaces] of Object.entries(page)) {
    for (const [namespace, bundle] of Object.entries(namespaces)) {
      instance.addResourceBundle(pageLanguage, namespace, bundle, true, true);
    }
  }
  assertI18nInstance(instance);
  return instance;
};

type RuntimeComponentResolver = NonNullable<ContextType<ModuleRuntimeBindings['RuntimeComponentResolverContext']>>;

/**
 * The resolution the i18n-integration runtime plugin registers: a page's federated boundary becomes the real
 * integration boundary; every other runtime component stays itself.
 */
const integrationResolver =
  (boundary: ModuleRuntimeBindings['FederatedI18nBoundary']): RuntimeComponentResolver =>
  (component, { name }) =>
    name === 'i18n.FederatedI18nBoundary' ? boundary : component;

/** The router navigation the Modern.js TanStack plugin hands the i18n plugin in production. */
const ModuleNavigation = ({
  bindings,
  children,
}: {
  readonly bindings: ModuleRuntimeBindings;
  readonly children: ReactNode;
}) => {
  const router = useRouter();
  const location = useLocation();
  const params = useParams({ strict: false });
  const { I18nNavigationProvider: NavigationProvider } = bindings;
  return (
    <NavigationProvider
      value={{
        createLinkProps: ({ hash, pathname, search }) => ({ hash, search, to: pathname }),
        framework: 'tanstack',
        hasRouter: true,
        Link,
        location: {
          hash: location.hash === '' ? '' : `#${location.hash}`,
          pathname: location.pathname,
          search: location.searchStr,
        },
        navigate: flow(
          (href: string, options?: { readonly replace?: boolean }) => ({
            replace: options?.replace === true,
            to: href,
          }),
          router.navigate,
        ),
        params,
      }}
    >
      {children}
    </NavigationProvider>
  );
};

/** The Modern.js providers a module page renders under: runtime component resolution and i18n. */
const ModuleProviders = ({
  bindings,
  children,
  resolve,
  translations,
}: {
  readonly bindings: ModuleRuntimeBindings;
  readonly children: ReactNode;
  readonly resolve: RuntimeComponentResolver;
  readonly translations: i18n;
}) => {
  const { ModernI18nProvider: I18nProvider, RuntimeComponentResolverContext: ResolverContext } = bindings;
  assertI18nInstance(translations);
  return (
    <ResolverContext.Provider value={resolve}>
      <I18nProvider value={{ i18nInstance: translations, language: translations.language, languages: ['cs', 'en'] }}>
        {children}
      </I18nProvider>
    </ResolverContext.Provider>
  );
};

/** The page's own i18n boundary around a part of the page, when the test passes the page's resources. */
const InPageBoundary = ({
  bindings,
  children,
  initOptions,
  resources,
}: {
  readonly bindings: ModuleRuntimeBindings;
  readonly children: ReactElement;
  readonly initOptions: ModuleI18nInit;
  readonly resources: PageResources | undefined;
}) => {
  const { FederatedI18nBoundary: IntegrationBoundary } = bindings;
  return resources === undefined ? (
    children
  ) : (
    <IntegrationBoundary
      defaultNamespace={initOptions.defaultNS}
      fallbackLanguage={initOptions.fallbackLng}
      resources={resources}
      supportedLanguages={['en', 'cs']}
    >
      {children}
    </IntegrationBoundary>
  );
};

/** The element a mounted route renders, replaceable as a parent re-render would replace it. */
const makeElementStore = (initial: ReactElement, settled: Effect.Effect<void>) => {
  let current = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const replace = (next: ReactElement) => {
    current = next;
    for (const listener of listeners) {
      listener();
    }
  };
  const Current = () => useSyncExternalStore(subscribe, () => current);
  const rerender = (next: ReactElement) =>
    acted(() => {
      replace(next);
    }, settled);
  return { Current, rerender } as const;
};

/** Mounts `element` in a fresh container and registers its unmount for `unmountAll`. */
const mountRoot = (element: ReactElement, settled: Effect.Effect<void>) => {
  const container = document.createElement('div');
  document.body.append(container);
  const view = createRoot(container);
  unmounts.push(() => {
    act(() => {
      view.unmount();
    });
    container.remove();
  });
  return acted(() => {
    view.render(element);
  }, settled);
};

export interface MountOptions {
  readonly language?: ModuleLanguage;
  /** The page route below `$lang`, as the route file declares it (`prodej/strany/$partyId`); default: any path. */
  readonly path?: string;
  /** The page's own `FederatedI18nBoundary resources`, for a test that renders a part of that page. */
  readonly resources?: PageResources;
  /** How mounting lets the page's work take a turn: `settleOnFakeTimers` under fake timers; default `settle`. */
  readonly settle?: Effect.Effect<void>;
  /** Where the router stands; default `/<language>/test`. */
  readonly url?: string;
}

/** The module's harness: its real copy, its provider tree and a router to mount a page or a part of one on. */
export const makeModuleUi = (bindings: ModuleRuntimeBindings) => {
  const { initOptions } = Schema.decodeUnknownSync(ModuleI18nOptions)(bindings.runtimeConfig).i18n;
  const resolve = integrationResolver(bindings.FederatedI18nBoundary);
  const moduleCopy = (language: ModuleLanguage, page: PageResources = {}) => makeCopy(initOptions, language, page);

  /**
   * The module's real text for `key`, for assertions. A key the catalogs do not translate fails here, so a test never
   * passes by matching an untranslated key the page printed.
   */
  const moduleText = (language: ModuleLanguage, page: PageResources = {}) => {
    const translations = moduleCopy(language, page);
    return (key: string, values: Readonly<Record<string, string | number>> = {}): string => {
      expect(translations.exists(key), `${key} has ${language} copy`).toBe(true);
      return translations.t(key, values);
    };
  };

  const ModuleRuntime = ({ children, translations }: { readonly children: ReactNode; readonly translations: i18n }) => (
    <ModuleProviders bindings={bindings} resolve={resolve} translations={translations}>
      {children}
    </ModuleProviders>
  );

  /**
   * Renders `element` as the page of a real TanStack router under the module's real i18n. Hooks such as
   * `useBlocker`, `useNavigate`, `useParams` and `useRouterState` read the live router; `rerender` replaces the
   * element as a parent re-render would.
   */
  const mountInRoute = (
    element: ReactElement,
    { language = 'cs', path = '$', resources, settle: settled = settle, url }: MountOptions = {},
  ) =>
    Effect.gen(function* mountRoute() {
      const translations = moduleCopy(language);
      const { Current, rerender } = makeElementStore(element, settled);
      const root = createRootRoute({
        component: () => (
          <ModuleNavigation bindings={bindings}>
            <Outlet />
          </ModuleNavigation>
        ),
      });
      const languageRoute = createRoute({ getParentRoute: () => root, path: '$lang' });
      const page = createRoute({
        component: () => (
          <InPageBoundary bindings={bindings} initOptions={initOptions} resources={resources}>
            <Current />
          </InPageBoundary>
        ),
        getParentRoute: () => languageRoute,
        path,
      });
      const router: AnyRouter = createRouter({
        history: createMemoryHistory({ initialEntries: [url ?? `/${language}/test`] }),
        routeTree: root.addChildren([languageRoute.addChildren([page])]),
      });
      yield* Effect.promise(async () => await router.load());
      yield* mountRoot(
        <ModuleRuntime translations={translations}>
          <RouterProvider router={router} />
        </ModuleRuntime>,
        settled,
      );
      return { rerender, router, translations } as const;
    });

  return { moduleCopy, ModuleRuntime, moduleText, mountInRoute } as const;
};
