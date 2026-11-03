import type {
  ModuleEntrypointDescriptor,
  ModuleEntrypointGatewayService as ModuleEntrypointAdapter,
  RunGatedModuleEntrypointInput,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { Effect, Result, Schema } from 'effect';

import type { ResolvedModuleTarget } from '../../shared/api.ts';

import type { ModuleEntrypointLoadIdentity } from './module-entrypoint-load-scheduler.ts';

export {
  MODULE_LOAD_CONCURRENCY,
  ModuleEntrypointNamespaceSchema,
  makeModuleEntrypointLoadScheduler,
  settleModuleEntrypointLoads,
} from './module-entrypoint-load-scheduler.ts';
export type {
  IdentifiedSettledModuleEntrypointLoad,
  ModuleEntrypointLoadFailure,
  ModuleEntrypointLoadIdentity,
  ModuleEntrypointLoadRequest,
  ModuleEntrypointNamespace,
  SettledModuleEntrypointLoad,
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
  function* pinBrowserModuleTargetEffect(target: ResolvedModuleTarget, browserDocument: Document) {
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
