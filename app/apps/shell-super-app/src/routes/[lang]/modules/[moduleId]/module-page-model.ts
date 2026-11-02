import { Effect, Fiber, Match, Schema } from 'effect';
import type { Cause, Config } from 'effect';

import { MODULE_TARGET_BATCH_LIMIT, ResolveModuleTargetPayloadSchema } from '../../../../../shared/api.ts';
import type {
  ResolveModuleTargetPayload,
  ResolvedModuleTarget,
  SafeTenantIdentity,
} from '../../../../../shared/api.ts';
import { resolveModuleTarget, resolveModuleTargets } from '../../../../api/auth-client.ts';
import type { ShellAuthenticationClientOptions, ShellTargetClientError } from '../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import {
  browserBaseUrl,
  browserReadKey,
  browserStaleWhileRevalidateCache,
  keyPart,
} from '../../../browser-swr-cache.ts';
import { registerSessionScopedReset } from '../../../session-scope.ts';
import { modulePageProps, prepareModulePage } from '../../../remote-page-loader.ts';
import {
  isServerRender,
  shellAuthenticationClientOptionsFromRequest,
} from '../../../shell-authentication-client-options.ts';
import { loadHomePageModel, sessionEndedModel } from '../../home-page-model.ts';
import { requireSignedIn } from '../../../sign-in-return.ts';
import type { HomePageModel } from '../../home-page-model.ts';

interface ModuleTargetLoaderArguments {
  readonly canonicalPath?: string;
  readonly params?: {
    readonly entrypointKey?: string;
    readonly moduleId: string;
  };
  readonly request: Request;
}

export type ModulePageRouteParams = Readonly<Record<string, string>>;

export type ResolvedModulePageModel = Extract<ModuleTargetPageModel, { readonly state: 'resolved' }>;

export type ModuleTargetPageModel =
  | {
      readonly shell: HomePageModel;
      readonly state: 'forbidden' | 'not_found' | 'reload_required' | 'selection_required' | 'unavailable';
    }
  | {
      readonly routeParams: ModulePageRouteParams;
      /** Raw query string of the opened URL (`?…` or ''), passed to the page and its `preloadPage`. */
      readonly search: string;
      readonly shell: HomePageModel;
      readonly state: 'resolved';
      readonly target: ResolvedModuleTarget;
    };

const safeState = (error: Config.ConfigError | ShellTargetClientError, shell: HomePageModel): ModuleTargetPageModel =>
  Match.value(error).pipe(
    Match.tag('ShellReloadRequiredProblem', () => ({ shell, state: 'reload_required' as const })),
    // The target read itself saying "sign in again" means the session died meanwhile.
    Match.tag('ShellAuthenticationRequiredProblem', () => ({
      shell: sessionEndedModel,
      state: 'selection_required' as const,
    })),
    Match.tag('ShellSelectionRequiredProblem', () => ({
      shell,
      state: 'selection_required' as const,
    })),
    Match.tag('ShellTargetForbiddenProblem', () => ({
      shell,
      state: 'forbidden' as const,
    })),
    Match.tag('ShellTargetNotFoundProblem', () => ({
      shell,
      state: 'not_found' as const,
    })),
    Match.tag(
      'ConfigError',
      'HttpClientError',
      'SchemaError',
      'ShellCapabilityUnavailableProblem',
      'ShellInternalProblem',
      'ShellInvalidRequestProblem',
      'ShellPolicyConflictProblem',
      'ShellPolicyUnprocessableProblem',
      'ShellPreconditionRequiredProblem',
      'ShellRateLimitedProblem',
      () => ({ shell, state: 'unavailable' as const }),
    ),
    Match.exhaustive,
  );

const ResolveModuleTargetPayloadJson = Schema.fromJsonString(ResolveModuleTargetPayloadSchema);

/**
 * A target resolution is fixed for one pinned release, tenant and legal entity, so the browser reuses it for the
 * cache's lifetime without background refreshes: a navigation or preload of a visited path resolves without a round
 * trip, and idle warming of the menu does not re-resolve every destination each time a page settles.
 */
const browserTargetCache = browserStaleWhileRevalidateCache(
  (key: string) => {
    const parts = key.split(keyPart);
    return Schema.decodeEffect(ResolveModuleTargetPayloadJson)(parts.at(-1) ?? '').pipe(
      Effect.flatMap((decoded) => resolveModuleTarget(decoded, { baseUrl: new URL(parts[0] ?? '') })),
    );
  },
  { capacity: 64, immutable: true, keep: () => true },
);

/** Resolved targets name the destinations of the person who resolved them; a session boundary drops them all. */
export const resetBrowserTargetCache = browserTargetCache.invalidateAll;
registerSessionScopedReset(resetBrowserTargetCache);

/** The browser cache key of one target read. */
const targetCacheKey = (cacheBaseUrl: string, identity: SafeTenantIdentity, payload: ResolveModuleTargetPayload) =>
  Schema.encodeEffect(ResolveModuleTargetPayloadJson)(payload).pipe(
    Effect.map((encoded) => browserReadKey(cacheBaseUrl, identity, encoded)),
  );

const targetFor = (
  payload: ResolveModuleTargetPayload,
  identity: SafeTenantIdentity,
  options: ShellAuthenticationClientOptions,
) => {
  const cacheBaseUrl = browserBaseUrl(options);
  return cacheBaseUrl === undefined
    ? resolveModuleTarget(payload, options)
    : targetCacheKey(cacheBaseUrl, identity, payload).pipe(Effect.flatMap(browserTargetCache.get));
};

/** A navigation waits this long for the page's code and primary data, then reveals what is ready. */
export const NAVIGATION_PREPARE_BUDGET = '2500 millis';

/**
 * Prepares a resolved page before the router reveals it: its remote page module and the module's primary data
 * (`preloadPage`), beside the reads the path made on its last visit. Route preloads on hover or focus run the loader
 * too, so a click usually finds both ready. The router keeps the previous page visible meanwhile. Browser only.
 */
export const prepareModuleTarget = (model: ModuleTargetPageModel, request: Request) =>
  model.state === 'resolved'
    ? prepareModulePage(
        model.target,
        modulePageProps(model.shell, model.routeParams, model.search),
        new URL(request.url).pathname,
        NAVIGATION_PREPARE_BUDGET,
      ).pipe(Effect.asVoid)
    : Effect.void;

const targetPayload = (
  selector: Pick<ModuleTargetLoaderArguments, 'canonicalPath' | 'params'>,
  compositionRevision?: string,
) => {
  const target = selector.canonicalPath === undefined ? selector.params : { canonicalPath: selector.canonicalPath };
  return Schema.decodeEffect(ResolveModuleTargetPayloadSchema)(
    compositionRevision === undefined ? { ...target } : { ...target, compositionRevision },
  );
};

/**
 * Idle preparation opens every menu destination at once, and each destination's loader resolved its target alone: one
 * Shell request (session, release, governed read) per destination. This resolves the targets the browser does not
 * hold yet in one request first, so those loaders find them. Each target is still its own governed read on the
 * server. A target the batch did not resolve is left to its loader, which reads it alone and shows its own state.
 */
export const prepareCanonicalTargets = Effect.fn('ModulePageModel.prepareCanonicalTargets')(
  function* prepareCanonicalTargetsEffect(request: Request, canonicalPaths: readonly string[]) {
    const options = yield* shellAuthenticationClientOptionsFromRequest(request);
    const cacheBaseUrl = browserBaseUrl(options);
    if (cacheBaseUrl === undefined || canonicalPaths.length === 0) {
      return;
    }
    const shell = yield* loadHomePageModel(request);
    if (shell.state !== 'authenticated' || shell.compositionRevision === undefined) {
      return;
    }
    const { compositionRevision, identity } = shell;
    const wanted = yield* Effect.forEach(
      [...new Set(canonicalPaths)].slice(0, MODULE_TARGET_BATCH_LIMIT),
      (canonicalPath) =>
        targetPayload({ canonicalPath }, compositionRevision).pipe(
          Effect.flatMap((payload) => targetCacheKey(cacheBaseUrl, identity, payload)),
          Effect.flatMap((key) =>
            browserTargetCache.has(key).pipe(Effect.map((held) => (held ? [] : [{ canonicalPath, key }]))),
          ),
        ),
      { concurrency: 1 },
    );
    const missing = wanted.flat();
    if (missing.length === 0) {
      return;
    }
    const { outcomes } = yield* resolveModuleTargets(
      { compositionRevision, targets: missing.map(({ canonicalPath }) => ({ canonicalPath })) },
      options,
    );
    yield* Effect.forEach(
      missing,
      ({ key }, index) => {
        const outcome = outcomes[index];
        return outcome?.state === 'resolved' && outcome.target.compositionRevision === compositionRevision
          ? browserTargetCache.prime(key, outcome.target)
          : Effect.void;
      },
      { concurrency: 1, discard: true },
    );
  },
);

/**
 * Server rendering resolves the page's target beside the Shell's own reads instead of after the composition: it asks
 * for the current release, and the answer counts only when it names the revision the composition read returned.
 */
const startServerTarget = (selector: Pick<ModuleTargetLoaderArguments, 'canonicalPath' | 'params'>, request: Request) =>
  Effect.forkChild(
    shellAuthenticationClientOptionsFromRequest(request).pipe(
      Effect.flatMap((options) =>
        targetPayload(selector).pipe(Effect.flatMap((payload) => resolveModuleTarget(payload, options))),
      ),
    ),
    { startImmediately: true },
  );

export const loadModulePageModel: (
  selector: ModuleTargetLoaderArguments,
) => Effect.Effect<ModuleTargetPageModel, Cause.TimeoutError> = Effect.fn('ModulePageModel.loadModulePageModel')(
  function* loadModulePageModelEffect(selector: ModuleTargetLoaderArguments) {
    const { request } = selector;
    const serverTarget = isServerRender() ? yield* startServerTarget(selector, request) : undefined;
    const targetScope = yield* Effect.scope;
    let browserTarget: Fiber.Fiber<ResolvedModuleTarget, ShellTargetClientError> | undefined;
    const shell = yield* loadHomePageModel(request, (identity, revision, options) =>
      targetPayload(selector, revision).pipe(
        Effect.flatMap((payload) => targetFor(payload, identity, options)),
        Effect.forkIn(targetScope, { startImmediately: true }),
        Effect.tap((fiber) =>
          Effect.sync(() => {
            browserTarget = fiber;
          }),
        ),
        Effect.asVoid,
      ),
    ).pipe(Effect.timeout('30 seconds'));
    if (shell.state !== 'authenticated') {
      return {
        shell,
        state: shell.state === 'anonymous' ? 'selection_required' : shell.state,
      } satisfies ModuleTargetPageModel;
    }
    if (shell.compositionRevision === undefined) {
      return { shell, state: 'selection_required' } satisfies ModuleTargetPageModel;
    }
    const { compositionRevision } = shell;
    const pendingTarget = serverTarget ?? browserTarget;
    const target =
      pendingTarget === undefined
        ? shellAuthenticationClientOptionsFromRequest(request).pipe(
            Effect.flatMap((options) =>
              targetPayload(selector, compositionRevision).pipe(
                Effect.flatMap((payload) => targetFor(payload, shell.identity, options)),
              ),
            ),
          )
        : Fiber.join(pendingTarget);
    return yield* target.pipe(
      Effect.map((resolved): ModuleTargetPageModel =>
        resolved.compositionRevision === compositionRevision
          ? {
              routeParams: resolved.routeParameters,
              search: new URL(request.url).search,
              shell,
              state: 'resolved',
              target: resolved,
            }
          : { shell, state: 'reload_required' },
      ),
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(safeState(error, shell)),
        onSuccess: Effect.succeed,
      }),
    );
  },
  Effect.scoped,
);

export const loader = (input: ModuleTargetLoaderArguments): Promise<ModuleTargetPageModel> =>
  browserRuntime.runPromise(
    loadModulePageModel(input).pipe(
      Effect.tap((model) => prepareModuleTarget(model, input.request)),
      Effect.map((model) => requireSignedIn(input.request, model)),
    ),
    {
      signal: input.request.signal,
    },
  );
