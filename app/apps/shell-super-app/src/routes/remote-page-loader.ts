import { Cache, Effect, Exit, Predicate, Schema } from 'effect';
import type { ComponentType } from 'react';

import { ResolvedModuleTargetSchema } from '../../shared/api.ts';
import type { ResolvedModuleTarget } from '../../shared/api.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { pinBrowserModuleTarget, settleModuleEntrypointLoads } from './module-entrypoint-loader.ts';

export type ApprovedModulePageComponent = ComponentType<{
  readonly routeParams: Readonly<Record<string, string>>;
  readonly target: ResolvedModuleTarget;
}>;

interface RemotePageModule {
  readonly default: ApprovedModulePageComponent;
}

export type RemoteState =
  | { readonly state: 'loading' }
  | {
      readonly reason: 'incompatible' | 'reload_required' | 'timeout' | 'unavailable';
      readonly state: 'unavailable';
    }
  | {
      readonly Component: ApprovedModulePageComponent;
      readonly state: 'ready';
    };

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

const loadRemotePageOnce = Effect.fn('RemotePageLoader.load')(function* loadRemotePageOnceEffect(target: RemotePage) {
  yield* pinBrowserModuleTarget(target, document);
  const { getInstance } = yield* browserFederationRuntime;
  const host = getInstance((instance) => instance.name === 'shellSuperApp');
  if (host === undefined || host === null) {
    return { reason: 'unavailable', state: 'unavailable' } satisfies RemoteState;
  }
  const { federation } = target;
  if (federation.remoteName === host.name) {
    return { reason: 'incompatible', state: 'unavailable' } satisfies RemoteState;
  }
  const [result] = yield* settleModuleEntrypointLoads([
    {
      identity: target,
      isCompatible: (loaded) =>
        Predicate.isObjectKeyword(loaded) &&
        loaded !== null &&
        'default' in loaded &&
        Predicate.isFunction(loaded.default),
      load: () => {
        host.registerRemotes([{ entry: federation.manifest.url, name: federation.remoteName }]);
        return host.loadRemote<RemotePageModule>(`${federation.remoteName}/${federation.expose.slice(2)}`);
      },
    },
  ]);
  if (result === undefined) {
    return { reason: 'unavailable', state: 'unavailable' } satisfies RemoteState;
  }
  if (result.state === 'unavailable') {
    return result;
  }
  if (result.value === null) {
    return { reason: 'incompatible', state: 'unavailable' } satisfies RemoteState;
  }
  return { Component: result.value.default, state: 'ready' } satisfies RemoteState;
});

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

/** Loads (or reuses) the remote page module of a resolved target. Never fails; outside a browser it never settles. */
export const loadRemotePage = (target: ResolvedModuleTarget): Effect.Effect<RemoteState> =>
  Schema.encodeEffect(RemotePageKey)({
    compositionRevision: target.compositionRevision,
    federation: target.federation,
  }).pipe(
    Effect.flatMap((key) => Cache.get(remotePages, key)),
    Effect.orElseSucceed((): RemoteState => ({ reason: 'incompatible', state: 'unavailable' })),
  );

/** Stable identity of a target's remote page, for comparing two loader results. */
export const remotePageIdentity = ({ compositionRevision, federation }: ResolvedModuleTarget): string =>
  [
    compositionRevision,
    federation.remoteName,
    federation.manifest.url,
    federation.manifest.sha256,
    federation.expose,
  ].join('\n');
