import type {
  ModuleEntrypointDescriptor,
  ModuleEntrypointGatewayService as ModuleEntrypointAdapter,
  RunGatedModuleEntrypointInput,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { Effect, Result, Schema } from 'effect';

import type { ResolvedModuleTarget } from '../../shared/api.ts';

import { ModuleEntrypointNamespaceSchema, settleModuleEntrypointLoads } from './module-entrypoint-load-scheduler.ts';
import type { ModuleEntrypointLoadIdentity, SettledModuleEntrypointLoad } from './module-entrypoint-load-scheduler.ts';

export {
  MODULE_LOAD_CONCURRENCY,
  ModuleEntrypointNamespaceSchema,
  makeModuleEntrypointLoadScheduler,
  settleModuleEntrypointLoads,
} from './module-entrypoint-load-scheduler.ts';
export type {
  ModuleEntrypointLoadFailure,
  ModuleEntrypointLoadIdentity,
  ModuleEntrypointNamespace,
} from './module-entrypoint-load-scheduler.ts';

const OwnerLoadIdentitySchema = Schema.Tuple([Schema.String, Schema.String]);
const ArtifactLoadIdentitySchema = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
]);
const ResultLoadIdentitySchema = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
]);

export class BrowserModuleRevisionConflict extends Schema.TaggedError<BrowserModuleRevisionConflict>()(
  'BrowserModuleRevisionConflict',
  { cause: Schema.optionalKey(Schema.Unknown) },
) {}

/** A browser document cannot replace an admitted release or a registered remote container. */
export const pinBrowserModuleTarget = Effect.fn('ModuleEntrypointLoader.pinBrowserModuleTarget')(
  function* pinBrowserModuleTargetEffect(
    target: Pick<ResolvedModuleTarget, 'compositionRevision' | 'federation'>,
    browserDocument: Document,
  ) {
    yield* pinDocumentCompositionRevision(target.compositionRevision, browserDocument).pipe(
      Effect.catchTag('DocumentCompositionRevisionError', (cause) =>
        Effect.fail(new BrowserModuleRevisionConflict({ cause })),
      ),
    );
    const { federation } = target;
    const artifact = `${federation.manifest.url}\n${federation.manifest.sha256}`;
    const identityKey = Symbol.for(`ontos.browser-federation.remote.${federation.remoteName}`);
    const previousArtifact = Object.getOwnPropertyDescriptor(browserDocument, identityKey);
    if (
      previousArtifact !== undefined &&
      (previousArtifact.value !== artifact ||
        previousArtifact.configurable === true ||
        previousArtifact.writable === true)
    ) {
      return yield* new BrowserModuleRevisionConflict();
    }
    if (previousArtifact === undefined) {
      yield* Effect.try({
        catch: (cause) => new BrowserModuleRevisionConflict({ cause }),
        try: () =>
          Object.defineProperty(browserDocument, identityKey, {
            configurable: false,
            enumerable: false,
            value: artifact,
            writable: false,
          }),
      });
    }
    return yield* Effect.void;
  },
);

/** Code identity only: no caller context, business data or authorization decision belongs in these keys. */
export const moduleEntrypointLoadIdentity = (
  target: Pick<
    ResolvedModuleTarget,
    'compositionRevision' | 'appId' | 'moduleId' | 'componentKey' | 'entrypointKey' | 'federation'
  >,
): ModuleEntrypointLoadIdentity => {
  const { federation } = target;
  return Object.freeze({
    artifact: Result.getOrThrow(
      Schema.encodeResult(Schema.fromJsonString(ArtifactLoadIdentitySchema))([
        target.compositionRevision,
        target.appId,
        target.moduleId,
        federation.remoteName,
        federation.manifest.url,
        federation.manifest.sha256,
      ]),
    ),
    owner: Result.getOrThrow(
      Schema.encodeResult(Schema.fromJsonString(OwnerLoadIdentitySchema))([target.appId, target.moduleId]),
    ),
    result: Result.getOrThrow(
      Schema.encodeResult(Schema.fromJsonString(ResultLoadIdentitySchema))([
        target.compositionRevision,
        target.appId,
        target.moduleId,
        federation.remoteName,
        federation.manifest.url,
        federation.manifest.sha256,
        federation.expose,
        target.componentKey,
        target.entrypointKey,
      ]),
    ),
  });
};

const browserFederationRuntime =
  import.meta.env.MODERN_TARGET === 'browser'
    ? Effect.tryPromise(() => import('@module-federation/modern-js-v3/runtime')).pipe(Effect.timeout('5 seconds'))
    : Effect.interrupt;

/** Loads only the pinned code identity; the caller's decoder validates its requested export. */
export const loadBrowserModuleEntrypoint = <Value>(
  target: Parameters<typeof moduleEntrypointLoadIdentity>[0],
  contract: Schema.Decoder<Value>,
) =>
  import.meta.env.MODERN_TARGET === 'browser'
    ? pinBrowserModuleTarget(target, document).pipe(
        Effect.andThen(browserFederationRuntime),
        Effect.flatMap(({ getInstance }): Effect.Effect<SettledModuleEntrypointLoad<Value>> => {
          const host = getInstance((instance) => instance.name === 'shellSuperApp');
          if (host === undefined || host === null) {
            return Effect.succeed({ reason: 'unavailable', state: 'unavailable' } as const);
          }
          const { federation } = target;
          if (federation.remoteName === host.name) {
            return Effect.succeed({ reason: 'incompatible', state: 'unavailable' } as const);
          }
          return settleModuleEntrypointLoads([
            {
              contract,
              identity: target,
              load: () =>
                Effect.tryPromise(() => {
                  host.registerRemotes([{ entry: federation.manifest.url, name: federation.remoteName }]);
                  return host.loadRemote(`${federation.remoteName}/${federation.expose.slice(2)}`);
                }).pipe(
                  Effect.retry({ times: 1 }),
                  Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
                ),
              loadIdentity: moduleEntrypointLoadIdentity(target),
            },
          ]).pipe(
            Effect.map(([result]) => result ?? { reason: 'unavailable' as const, state: 'unavailable' as const }),
          );
        }),
      )
    : Effect.interrupt;

export type LazyModuleEntrypointLoad<Value, AuthorizationError, LoadError, Requirements> = Omit<
  RunGatedModuleEntrypointInput<Value, AuthorizationError, LoadError, Requirements>,
  'entrypoint' | 'snapshot'
> & {
  readonly entrypoint: ModuleEntrypointDescriptor<'page' | 'public_component'>;
};

/** Shell-only composition seam. Callers pass typed descriptors and lazy Effects, never remote strings. */
export const loadModuleEntrypointComposition = Effect.fn('ModuleEntrypointLoader.loadModuleEntrypointComposition')(
  function* loadModuleEntrypointCompositionEffect<Value, AuthorizationError, LoadError, Requirements>(
    gateway: ModuleEntrypointAdapter,
    context: Readonly<TrustedPrincipalContext>,
    loads: readonly LazyModuleEntrypointLoad<Value, AuthorizationError, LoadError, Requirements>[],
  ) {
    const snapshot = yield* gateway.prepareSnapshot(
      context,
      loads.map((load) => load.entrypoint),
    );
    yield* Effect.forEach(loads, (load: (typeof loads)[number]) => gateway.check(snapshot, load.entrypoint), {
      concurrency: 1,
    });
    return yield* Effect.forEach(loads, (load: (typeof loads)[number]) => gateway.run({ ...load, snapshot }), {
      concurrency: 1,
    });
  },
);
