import { Deferred, Effect, Exit, Option, Ref } from 'effect';
import type { Scope } from 'effect';

import { rootRouteTarget } from '../shared/mcp-resource.ts';
import { oauthMetadataTarget } from '../shared/oauth-metadata-routes.ts';

const OAUTH_PAGE_PATH = /^\/(?:cs|en)\/(?:login|pripojit|connect)(?:\/.*)?$/u;

export const isOAuthPagePath = (path: string): boolean => OAUTH_PAGE_PATH.test(path);

export interface MiddlewareContext {
  readonly req: { readonly method: string; readonly path: string; readonly raw?: Request; readonly url?: string };
  res: Response;
}

const METADATA_CORS_HEADERS = {
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-origin': '*',
} as const;

const requestAborted = (signal: AbortSignal): Effect.Effect<never> =>
  Effect.callback((resume) => {
    const abort = () => resume(Effect.interrupt);
    if (signal.aborted) {
      abort();
      return Effect.void;
    }
    signal.addEventListener('abort', abort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', abort));
  });

export const serveRootMetadataAlias = <Failure, Requirements>(
  handleCanonical: (request: Request) => Effect.Effect<Response, Failure, Requirements>,
) =>
  Effect.fn('Shell.serveRootMetadataAlias')(function* serveMetadata<NextFailure, NextRequirements>(
    context: MiddlewareContext,
    next: Effect.Effect<void, NextFailure, NextRequirements>,
  ) {
    const target = oauthMetadataTarget(context.req.path);
    if (target === undefined) {
      return yield* next.pipe(Effect.as(Option.none<Response>()));
    }
    if (context.req.method === 'OPTIONS') {
      return Option.some(new Response(null, { headers: METADATA_CORS_HEADERS, status: 204 }));
    }
    if (context.req.method !== 'GET' && context.req.method !== 'HEAD') {
      return Option.some(
        new Response(null, { headers: { ...METADATA_CORS_HEADERS, allow: 'GET, HEAD, OPTIONS' }, status: 405 }),
      );
    }
    // Only the origin is carried into the canonical request; Better Auth pins its configured issuer.
    const canonical = new URL(target, context.req.url ?? 'https://shell.invalid');
    const signal = context.req.raw?.signal;
    if (signal?.aborted === true) {
      return yield* Effect.interrupt;
    }
    const init: RequestInit = { headers: { accept: 'application/json' } };
    const request = new Request(canonical, signal === undefined ? init : { ...init, signal });
    const response = handleCanonical(request);
    const upstream = yield* signal === undefined ? response : Effect.raceFirst(response, requestAborted(signal));
    const body = yield* Effect.tryPromise(upstream.text.bind(upstream)).pipe(Effect.timeout('30 seconds'));
    const headers = new Headers(upstream.headers);
    headers.delete('content-length');
    headers.delete('access-control-allow-credentials');
    for (const [name, value] of Object.entries(METADATA_CORS_HEADERS)) {
      headers.set(name, value);
    }
    return Option.some(new Response(context.req.method === 'HEAD' ? null : body, { headers, status: upstream.status }));
  });

const BFF_PREFIX = '/shell-super-app-api';

/** Root routes owned by the BFF are served in-process with their canonical request path. */
export const serveRootRoute = <Failure, Requirements>(
  handle: (request: Request) => Effect.Effect<Response, Failure, Requirements>,
) =>
  Effect.fn('Shell.serveRootRoute')(function* serveRoute<NextFailure, NextRequirements>(
    context: MiddlewareContext,
    next: Effect.Effect<void, NextFailure, NextRequirements>,
  ) {
    const target = rootRouteTarget(context.req.path);
    const { raw } = context.req;
    if (target === undefined || raw === undefined) {
      return yield* next.pipe(Effect.as(Option.none<Response>()));
    }
    if (raw.signal.aborted) {
      return yield* Effect.interrupt;
    }
    const url = new URL(raw.url);
    url.pathname = target.slice(BFF_PREFIX.length);
    const response = yield* Effect.raceFirst(handle(new Request(url, raw)), requestAborted(raw.signal));
    return Option.some(response);
  });

export const oauthPageSecurityHeaders = Effect.fn('Shell.oauthPageSecurityHeaders')(function* pageSecurityHeaders<
  Failure,
  Requirements,
>(context: MiddlewareContext, next: Effect.Effect<void, Failure, Requirements>) {
  yield* next;
  if (!isOAuthPagePath(context.req.path)) {
    return;
  }
  const headers = new Headers(context.res.headers);
  headers.set('cache-control', 'no-store');
  headers.set('content-security-policy', "frame-ancestors 'none'");
  headers.set('x-frame-options', 'DENY');
  context.res = new Response(context.res.body, {
    headers,
    status: context.res.status,
    statusText: context.res.statusText,
  });
});

interface ModuleLoadAttempt<Module, Failure> {
  readonly deferred: Deferred.Deferred<Module, Failure>;
  readonly start: boolean;
}

type RestoreInterruptibility = Parameters<Parameters<typeof Effect.uninterruptibleMask>[0]>[0];

type ModuleCache<Module, Failure> = Ref.Ref<Option.Option<Deferred.Deferred<Module, Failure>>>;

const selectModuleLoad = <Module, Failure>(
  current: ModuleCache<Module, Failure>,
  candidate: Deferred.Deferred<Module, Failure>,
) =>
  Ref.modify(current, (existing) => {
    const attempt: ModuleLoadAttempt<Module, Failure> = Option.isSome(existing)
      ? { deferred: existing.value, start: false }
      : { deferred: candidate, start: true };
    return [attempt, Option.some(attempt.deferred)] as const;
  });

const completeModuleLoad = <Module, Failure>(
  current: ModuleCache<Module, Failure>,
  deferred: Deferred.Deferred<Module, Failure>,
  exit: Exit.Exit<Module, Failure>,
) =>
  Ref.update(current, (active) =>
    Exit.isFailure(exit) && Option.isSome(active) && active.value === deferred ? Option.none() : active,
  ).pipe(Effect.andThen(Deferred.done(deferred, exit)));

/**
 * Pending callers share one host-owned load; successful loads remain cached. Failed loads are discarded
 * before callers resume. Cancelling a request cancels only its wait, never the shared import.
 */
const awaitModule = Effect.fn('Shell.awaitModule')(
  <Module, Failure>(load: Effect.Effect<Module, Failure>, current: ModuleCache<Module, Failure>, owner: Scope.Scope) =>
    Effect.uninterruptibleMask(
      Effect.fn('Shell.awaitCachedModule')(function* awaitCachedModule(restore: RestoreInterruptibility) {
        const candidate = yield* Deferred.make<Module, Failure>();
        const attempt = yield* selectModuleLoad(current, candidate);
        if (attempt.start) {
          const runLoad = load.pipe(Effect.onExit((exit) => completeModuleLoad(current, attempt.deferred, exit)));
          yield* Effect.forkIn(runLoad.pipe(Effect.ignore), owner, { startImmediately: true, uninterruptible: false });
        }
        return yield* restore(Deferred.await(attempt.deferred));
      }),
    ),
);

export const preloadModule = Effect.fn('Shell.preloadModule')(
  <Module, Failure>(
    load: Effect.Effect<Module, Failure>,
  ): Effect.Effect<Effect.Effect<Module, Failure>, never, Scope.Scope> =>
    Effect.all(
      {
        current: Ref.make<Option.Option<Deferred.Deferred<Module, Failure>>>(Option.none()),
        owner: Effect.scope,
      },
      { concurrency: 1 },
    ).pipe(Effect.map(({ current, owner }) => awaitModule(load, current, owner))),
);

const moduleUnavailable = (): Response =>
  Response.json(
    { error: 'temporarily_unavailable' },
    { headers: { 'cache-control': 'no-store', 'retry-after': '1' }, status: 503 },
  );

/** A module-load failure maps to retryable 503; the handler retains its own typed failures. */
export const viaModule = <Module, LoadFailure, ModuleRequirements, HandlerFailure, HandlerRequirements>(
  module: Effect.Effect<Module, LoadFailure, ModuleRequirements>,
  handle: (loaded: Module, request: Request) => Effect.Effect<Response, HandlerFailure, HandlerRequirements>,
) =>
  Effect.fn('Shell.viaModule')((request: Request) =>
    module.pipe(
      Effect.matchEffect({
        onFailure: (failure) =>
          Effect.logWarning('Shell BFF module is unavailable', failure).pipe(Effect.as(moduleUnavailable())),
        onSuccess: (loaded) => handle(loaded, request),
      }),
    ),
  );
