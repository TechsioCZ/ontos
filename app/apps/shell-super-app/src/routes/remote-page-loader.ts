import type { ModulePagePreload, ModulePageProps } from '@app/shared-contracts/page-data';
import { Cache, Context, Effect, Exit, MutableHashMap, Predicate, Schema } from 'effect';
import type { Duration, Option } from 'effect';
import type { ComponentType } from 'react';

import { ResolvedModuleTargetSchema } from '../../shared/api.ts';
import type { ResolvedModuleTarget } from '../../shared/api.ts';
import type { HomePageModel } from './[lang]/home-page-model.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import {
  prefetchRecordedReads,
  withoutRecordedPageReads,
  withPrimaryModulePreparation,
} from './browser-request-cache.ts';
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

const browserFederationRuntime =
  import.meta.env.MODERN_TARGET === 'browser'
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
  import.meta.env.MODERN_TARGET === 'browser'
    ? Effect.flatMap(pinBrowserModuleTarget(target, document), () => browserFederationRuntime).pipe(
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
      )
    : Effect.interrupt;

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

/** Native boundary for module code loading and the legacy recorded-read fallback. */
export const RemotePagePreparation = Context.Reference<{
  readonly load: typeof loadRemotePage;
  readonly prefetch: typeof prefetchRecordedReads;
}>('RemotePagePreparation', {
  defaultValue: () => ({ load: loadRemotePage, prefetch: prefetchRecordedReads }),
});

/** The props a page and its `preloadPage` both receive: the person's context, the route parameters and the query. */
export const modulePageProps = (
  shell: HomePageModel,
  routeParams: Readonly<Record<string, string>>,
  search: string,
): ModulePageProps =>
  shell.state === 'authenticated' && shell.selectedLegalEntityId !== undefined
    ? {
        context: {
          displayName: shell.identity.displayName,
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

const preloadPageData = (remote: RemoteState, props: ModulePageProps) => {
  if (remote.state !== 'ready' || remote.preloadPage === undefined) {
    return Effect.void;
  }
  const { preloadPage } = remote;
  return withoutRecordedPageReads(() => preloadPage(props)).pipe(Effect.ignore);
};

/**
 * Loads the remote module, then uses its declared preload or the legacy recorded reads, never both. Waiting for
 * the module delays the legacy fallback, but avoids replaying an old request beside a fresh declared read.
 * Module loading and data preparation share the caller's budget. A declared failure or timeout never selects
 * the fallback. A no-op on the server, where a remote never loads.
 */
export const prepareModulePage = (
  target: RemotePage,
  props: ModulePageProps,
  pathname: string,
  budget: Duration.Input,
): Effect.Effect<Option.Option<RemoteState>> =>
  Effect.suspend(() =>
    'document' in globalThis
      ? Effect.gen(function* prepareRemotePage() {
          const { load, prefetch } = yield* RemotePagePreparation;
          const remote = yield* load(target);
          yield* remote.state === 'ready' && remote.preloadPage !== undefined
            ? preloadPageData(remote, props)
            : prefetch(pathname);
          return remote;
        }).pipe(Effect.timeoutOption(budget), (work) => withPrimaryModulePreparation(pathname, work))
      : Effect.succeedNone,
  );
