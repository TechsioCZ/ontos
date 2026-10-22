import { Effect, Fiber, Match, Schema } from 'effect';
import type { Cause, Config } from 'effect';

import { ResolveModuleTargetPayloadSchema } from '../../../../../shared/api.ts';
import type { ResolveModuleTargetPayload, ResolvedModuleTarget } from '../../../../../shared/api.ts';
import { resolveModuleTarget } from '../../../../api/auth-client.ts';
import type { ShellAuthenticationClientOptions, ShellTargetClientError } from '../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { prefetchRecordedReads } from '../../../browser-request-cache.ts';
import {
  browserBaseUrl,
  browserReadKey,
  browserStaleWhileRevalidateCache,
  keyPart,
} from '../../../browser-swr-cache.ts';
import { loadRemotePage } from '../../../remote-page-loader.ts';
import {
  isServerRender,
  shellAuthenticationClientOptionsFromRequest,
} from '../../../shell-authentication-client-options.ts';
import { loadHomePageModel, sessionEndedModel } from '../../home-page-model.ts';
import { requireSignedIn } from '../../../sign-in-return.ts';
import type { AuthenticatedHomePageModel, HomePageModel } from '../../home-page-model.ts';

interface ModuleTargetLoaderArguments {
  readonly canonicalPath?: string;
  readonly params?: {
    readonly entrypointKey?: string;
    readonly moduleId: string;
  };
  readonly request: Request;
}

export type ModulePageRouteParams = Readonly<Record<string, string>>;

export type ModuleTargetPageModel =
  | {
      readonly shell: HomePageModel;
      readonly state: 'forbidden' | 'not_found' | 'reload_required' | 'selection_required' | 'unavailable';
    }
  | {
      readonly routeParams: ModulePageRouteParams;
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

const targetFor = (
  payload: ResolveModuleTargetPayload,
  shell: AuthenticatedHomePageModel,
  options: ShellAuthenticationClientOptions,
) => {
  const cacheBaseUrl = browserBaseUrl(options);
  return cacheBaseUrl === undefined
    ? resolveModuleTarget(payload, options)
    : Schema.encodeEffect(ResolveModuleTargetPayloadJson)(payload).pipe(
        Effect.flatMap((encoded) => browserTargetCache.get(browserReadKey(cacheBaseUrl, shell.identity, encoded))),
      );
};

/**
 * Starts loading what a resolved page needs before it renders: its remote page module and the module reads the
 * path made on its last visit. Route preloads (links in view, idle preloading) run the loader, so this makes a
 * later click render the page, and usually its data, at once. Detached: a cancelled navigation keeps the work.
 */
export const preloadModuleTarget = (model: ModuleTargetPageModel, pathname: string) =>
  'document' in globalThis && model.state === 'resolved'
    ? Effect.forkDetach(
        Effect.all([loadRemotePage(model.target), prefetchRecordedReads(pathname)], {
          concurrency: 2,
          discard: true,
        }),
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
    const shell = yield* loadHomePageModel(request).pipe(Effect.timeout('30 seconds'));
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
    const target =
      serverTarget === undefined
        ? shellAuthenticationClientOptionsFromRequest(request).pipe(
            Effect.flatMap((options) =>
              targetPayload(selector, compositionRevision).pipe(
                Effect.flatMap((payload) => targetFor(payload, shell, options)),
              ),
            ),
          )
        : Fiber.join(serverTarget);
    return yield* target.pipe(
      Effect.map((resolved): ModuleTargetPageModel =>
        resolved.compositionRevision === compositionRevision
          ? { routeParams: resolved.routeParameters, shell, state: 'resolved', target: resolved }
          : { shell, state: 'reload_required' },
      ),
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(safeState(error, shell)),
        onSuccess: Effect.succeed,
      }),
    );
  },
);

export const loader = (input: ModuleTargetLoaderArguments): Promise<ModuleTargetPageModel> =>
  browserRuntime
    .runPromise(
      loadModulePageModel(input).pipe(
        Effect.tap((model) => preloadModuleTarget(model, new URL(input.request.url).pathname)),
      ),
      { signal: input.request.signal },
    )
    .then((model) => requireSignedIn(input.request, model));
