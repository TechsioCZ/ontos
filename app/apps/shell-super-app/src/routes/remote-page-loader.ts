import type { ModulePagePreload, ModulePageProps } from '@app/shared-contracts/page-data';
import { Cache, Effect, Exit, MutableHashMap, Predicate, Schema } from 'effect';
import type { Duration, Option } from 'effect';
import type { ComponentType } from 'react';

import { ResolvedModuleTargetSchema } from '../../shared/api.ts';
import type { ResolvedModuleTarget } from '../../shared/api.ts';
import type { HomePageModel } from './[lang]/home-page-model.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { prefetchRecordedReads } from './browser-request-cache.ts';
import { pinBrowserModuleTarget, settleModuleEntrypointLoads } from './module-entrypoint-loader.ts';

/** Every exposed page or component: the props its `preloadPage` received, plus the resolved target. */
export type ModulePageComponent = ComponentType<ModulePageProps & { readonly target: ResolvedModuleTarget }>;

interface RemotePageModule {
  readonly default: ModulePageComponent;
  readonly preloadPage?: ModulePagePreload;
}

export type RemoteState =
  | { readonly state: 'loading' }
  | {
      readonly reason: 'incompatible' | 'reload_required' | 'timeout' | 'unavailable';
      readonly state: 'unavailable';
    }
  | {
      readonly Component: ModulePageComponent;
      readonly preloadPage?: ModulePagePreload;
      readonly state: 'ready';
    };

export type ReadyRemotePage = Extract<RemoteState, { readonly state: 'ready' }>;

const browserFederationRuntime = __ONTOS_BROWSER_BUILD__
  ? Effect.tryPromise(() => import('@module-federation/modern-js-v3/runtime')).pipe(Effect.timeout('5 seconds'))
  : Effect.interrupt;

/** What identifies one remote page module: the release, its remote container and the exposed page. */
const RemotePageSchema = ResolvedModuleTargetSchema.mapFields(({ compositionRevision, federation }) => ({
  compositionRevision,
  federation,
}));
type RemotePage = typeof RemotePageSchema.Type;
const RemotePageKey = Schema.fromJsonString(RemotePageSchema);

/** Stable identity of a target's remote page, for comparing two loader results. */
export const remotePageIdentity = ({ compositionRevision, federation }: RemotePage): string =>
  [
    compositionRevision,
    federation.remoteName,
    federation.manifest.url,
    federation.manifest.sha256,
    federation.expose,
  ].join('\n');

/** Loaded page modules by remote page identity, for a synchronous lookup while rendering. */
const readyPages = MutableHashMap.empty<string, ReadyRemotePage>();

const loadRemotePageOnce = (target: RemotePage) =>
  Effect.flatMap(pinBrowserModuleTarget(target, document), () => browserFederationRuntime).pipe(
    Effect.flatMap(({ getInstance }) => {
      const host = getInstance((instance) => instance.name === 'shellSuperApp');
      if (host === undefined || host === null) {
        return Effect.succeed<RemoteState>({ reason: 'unavailable', state: 'unavailable' });
      }
      const { federation } = target;
      if (federation.remoteName === host.name) {
        return Effect.succeed<RemoteState>({ reason: 'incompatible', state: 'unavailable' });
      }
      return settleModuleEntrypointLoads([
        {
          identity: target,
          isCompatible: (loaded) =>
            Predicate.isObjectKeyword(loaded) &&
            loaded !== null &&
            'default' in loaded &&
            Predicate.isFunction(loaded.default) &&
            (!('preloadPage' in loaded) ||
              loaded.preloadPage === undefined ||
              Predicate.isFunction(loaded.preloadPage)),
          load: () => {
            host.registerRemotes([{ entry: federation.manifest.url, name: federation.remoteName }]);
            return host.loadRemote<RemotePageModule>(`${federation.remoteName}/${federation.expose.slice(2)}`);
          },
        },
      ]).pipe(
        Effect.map(([result]): RemoteState => {
          if (result === undefined) {
            return { reason: 'unavailable', state: 'unavailable' };
          }
          if (result.state === 'unavailable') {
            return result;
          }
          if (result.value === null) {
            return { reason: 'incompatible', state: 'unavailable' };
          }
          const { default: Component, preloadPage } = result.value;
          const ready: ReadyRemotePage =
            preloadPage === undefined ? { Component, state: 'ready' } : { Component, preloadPage, state: 'ready' };
          MutableHashMap.set(readyPages, remotePageIdentity(target), ready);
          return ready;
        }),
      );
    }),
    Effect.withSpan('RemotePageLoader.load'),
  );

/**
 * Remote page modules by release and exposed page. A route preload and the page share one load, and a revisit
 * renders the loaded module without waiting. Only ready modules are kept, so a failed load is tried again.
 */
const remotePages = browserRuntime.runSync(
  Cache.makeWith(
    (key: string) =>
      Schema.decodeEffect(RemotePageKey)(key).pipe(
        Effect.flatMap(loadRemotePageOnce),
        Effect.catchTags({
          BrowserModuleRevisionConflict: () =>
            Effect.succeed<RemoteState>({ reason: 'reload_required', state: 'unavailable' }),
          SchemaError: () => Effect.succeed<RemoteState>({ reason: 'incompatible', state: 'unavailable' }),
          TimeoutError: () => Effect.succeed<RemoteState>({ reason: 'timeout', state: 'unavailable' }),
          UnknownError: () => Effect.succeed<RemoteState>({ reason: 'unavailable', state: 'unavailable' }),
        }),
      ),
    {
      capacity: 64,
      timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value.state === 'ready' ? Infinity : 0),
    },
  ),
);

/**
 * Loads (or reuses) the remote page module of a release's exposed page. Never fails; outside a browser it never
 * settles, so the server must not wait for it.
 */
export const loadRemotePage = (target: RemotePage): Effect.Effect<RemoteState> =>
  Schema.encodeEffect(RemotePageKey)({
    compositionRevision: target.compositionRevision,
    federation: target.federation,
  }).pipe(
    Effect.flatMap((key) => Cache.get(remotePages, key)),
    Effect.orElseSucceed((): RemoteState => ({ reason: 'incompatible', state: 'unavailable' })),
  );

/** The props a page and its `preloadPage` both receive: the person's context, the route parameters and the query. */
export const modulePageProps = (
  shell: HomePageModel,
  routeParams: Readonly<Record<string, string>>,
  search: string,
): ModulePageProps =>
  shell.state === 'authenticated' && shell.selectedLegalEntityId !== undefined
    ? {
        context: {
          legalEntityId: shell.selectedLegalEntityId,
          principalId: shell.identity.principalId,
          tenantId: shell.identity.tenantId,
        },
        routeParams,
        search,
      }
    : { routeParams, search };

/** The target's page module when it is already loaded, so a page can render it in its first commit. */
export const peekRemotePage = (target: RemotePage): Option.Option<ReadyRemotePage> =>
  MutableHashMap.get(readyPages, remotePageIdentity(target));

/** A module's `preloadPage` settles on its own; this only bounds one that never does. */
const PRELOAD_PAGE_LIMIT = '30 seconds';

const preloadPageData = (remote: RemoteState, props: ModulePageProps) => {
  if (remote.state !== 'ready' || remote.preloadPage === undefined) {
    return Effect.void;
  }
  const { preloadPage } = remote;
  return Effect.tryPromise(() => preloadPage(props)).pipe(Effect.timeout(PRELOAD_PAGE_LIMIT), Effect.ignore);
};

/**
 * Prepares a page before it is revealed: loads its remote page module and then runs the module's `preloadPage` with
 * the props the page will receive, beside the warm-up of the reads the path made on its last visit. Waits at most
 * `budget`; answers the module's state, or none when the budget ran out first. A no-op on the server, where a remote
 * never loads.
 */
export const prepareModulePage = (
  target: RemotePage,
  props: ModulePageProps,
  pathname: string,
  budget: Duration.Input,
): Effect.Effect<Option.Option<RemoteState>> =>
  Effect.suspend(() =>
    'document' in globalThis
      ? Effect.all(
          [
            loadRemotePage(target).pipe(Effect.tap((remote) => preloadPageData(remote, props))),
            prefetchRecordedReads(pathname),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([remote]) => remote),
          Effect.timeoutOption(budget),
        )
      : Effect.succeedNone,
  );
