import type { problemDetailsContentType } from '@app/shared-contracts/problem-details';
import type { SYMMY_REST_PREFIX } from '@app/shared-contracts/symmy/route-catalog';
import { DEFAULT_DATA_BATCH_ENDPOINT } from '@modern-js/bff-effect/data-platform';
import type effectServerPlugin from '@modern-js/plugin-bff-extensions/effect-server';
import { Data, Effect, Function as Fn, Option } from 'effect';
import type { Schema } from 'effect';

import { oauthPageSecurityHeaders, serveRootMetadataAlias, serveRootRoute, viaModule } from './root-routes.ts';
import type { MiddlewareContext } from './root-routes.ts';
import { guardCredentialSubmission } from './credential-submission.ts';
import { symmyRouteNotFoundPayload } from '../shared/symmy-route-not-found.ts';

import { SHELL_HTTP_BUDGET, shellBff, shellServerRuntime } from '../src/runtime/shell-server-runtime.ts';

const ShellBffRequestError = Data.TaggedError('ShellBffRequestError')<{ readonly cause: Schema.Defect['Type'] }>;

process.once('beforeExit', () => {
  void shellServerRuntime.dispose();
});
shellServerRuntime.runFork(
  shellBff.pipe(
    Effect.tapError((failure) => Effect.logWarning('Shell BFF startup import failed; a request can retry', failure)),
    Effect.ignore,
  ),
);

const metadata = serveRootMetadataAlias(
  viaModule(shellBff, (bff, request) =>
    Effect.tryPromise({
      catch: (cause) => new ShellBffRequestError({ cause }),
      try: bff.handleOAuthMetadata.bind(bff, request),
    }).pipe(Effect.timeout(SHELL_HTTP_BUDGET)),
  ),
);
const rootRoute = serveRootRoute(
  viaModule(shellBff, (bff, request) =>
    Effect.tryPromise({
      catch: (cause) => new ShellBffRequestError({ cause }),
      try: bff.handleRootRoute.bind(bff, request),
    }).pipe(Effect.timeout(SHELL_HTTP_BUDGET)),
  ),
);

// Modern's unbundled Node server config keeps these imports type-only.
const symmyRestPrefix = '/api/symmy/v1' satisfies typeof SYMMY_REST_PREFIX;
const problemContentType = 'application/problem+json' satisfies typeof problemDetailsContentType;

const rejectBatchAlias = (context: {
  json: (problem: typeof symmyRouteNotFoundPayload, status: 404, headers: Record<string, string>) => Response;
}) =>
  context.json(symmyRouteNotFoundPayload, symmyRouteNotFoundPayload.status, {
    'Cache-Control': 'no-store',
    'Content-Type': problemContentType,
  });

const rejectSymmyBatchAlias: ReturnType<typeof effectServerPlugin> = {
  name: 'ontos:reject-symmy-batch-alias',
  setup(api) {
    api.onPrepare(() => {
      const prefix = api.getServerConfig()?.bff?.prefix;
      if (!Array.isArray(prefix) || !prefix.includes(symmyRestPrefix)) {
        return;
      }

      // The framework handles its batch envelope before any Effect route policy runs.
      api.getServerContext().middlewares.push({
        handler: Fn.flow(
          rejectBatchAlias,
          Promise.resolve.bind<PromiseConstructor, [], [Response], Promise<Response>>(Promise),
        ),
        method: 'all',
        name: 'ontos:reject-symmy-batch-alias',
        order: 'pre',
        path: `${symmyRestPrefix}${DEFAULT_DATA_BATCH_ENDPOINT}`,
      });
    });
  },
};

export default {
  middlewares: [
    {
      handler: Fn.flow(
        (context: MiddlewareContext, next: () => Promise<void>) =>
          (shellServerRuntime.runPromise<
            Response | undefined,
            Effect.Error<ReturnType<typeof guardCredentialSubmission>>
          >).bind(
            shellServerRuntime,
            guardCredentialSubmission(context, Effect.promise(next).pipe(Effect.timeout(SHELL_HTTP_BUDGET))).pipe(
              Effect.map(Option.getOrUndefined),
            ),
            { signal: context.req.raw?.signal },
          ),
        Fn.apply({}),
      ),
      name: 'ontos-credential-submission',
      order: 'pre',
    },
    {
      handler: Fn.flow(
        (context: MiddlewareContext, next: () => Promise<void>) =>
          (shellServerRuntime.runPromise<Response | undefined, Effect.Error<ReturnType<typeof metadata>>>).bind(
            shellServerRuntime,
            metadata(context, Effect.promise(next).pipe(Effect.timeout(SHELL_HTTP_BUDGET))).pipe(
              Effect.map(Option.getOrUndefined),
            ),
            { signal: context.req.raw?.signal },
          ),
        Fn.apply({}),
      ),
      name: 'ontos-oauth-root-metadata',
      order: 'pre',
    },
    {
      handler: Fn.flow(
        (context: MiddlewareContext, next: () => Promise<void>) =>
          (shellServerRuntime.runPromise<Response | undefined, Effect.Error<ReturnType<typeof rootRoute>>>).bind(
            shellServerRuntime,
            rootRoute(context, Effect.promise(next).pipe(Effect.timeout(SHELL_HTTP_BUDGET))).pipe(
              Effect.map(Option.getOrUndefined),
            ),
            { signal: context.req.raw?.signal },
          ),
        Fn.apply({}),
      ),
      name: 'ontos-bff-root-routes',
      order: 'pre',
    },
    {
      handler: Fn.flow(
        (context: MiddlewareContext, next: () => Promise<void>) =>
          (shellServerRuntime.runPromise<
            Effect.Success<ReturnType<typeof oauthPageSecurityHeaders>>,
            Effect.Error<ReturnType<typeof oauthPageSecurityHeaders>>
          >).bind(
            shellServerRuntime,
            oauthPageSecurityHeaders(context, Effect.promise(next).pipe(Effect.timeout(SHELL_HTTP_BUDGET))),
            { signal: context.req.raw?.signal },
          ),
        Fn.apply({}),
      ),
      name: 'ontos-oauth-page-headers',
      order: 'pre',
    },
  ],
  plugins: [rejectSymmyBatchAlias],
};
