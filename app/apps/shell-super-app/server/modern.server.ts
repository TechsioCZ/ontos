import { Data, Effect, Function as Fn, Option } from 'effect';
import type { Schema } from 'effect';

import { oauthPageSecurityHeaders, serveRootMetadataAlias, serveRootRoute, viaModule } from './root-routes.ts';
import type { MiddlewareContext } from './root-routes.ts';

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

export default {
  middlewares: [
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
};
