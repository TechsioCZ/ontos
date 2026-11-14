import type { PAYMENT_GATEWAY_RELAY_PATH_PREFIX } from '@app/payment/payment-gateway-relay';
import type { problemDetailsContentType } from '@app/shared-contracts/problem-details';
import type { SYMMY_REST_PREFIX } from '@app/shared-contracts/symmy/route-catalog';
import { DEFAULT_DATA_BATCH_ENDPOINT } from '@modern-js/bff-effect/data-platform';
import type effectServerPlugin from '@modern-js/plugin-bff-extensions/effect-server';
import { Data, Effect, Function as Fn, Option } from 'effect';
import type { Schema } from 'effect';
import { Literal, String as SchemaString, TaggedStruct } from 'effect/Schema';

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
const paymentGatewayRelayPrefix = '/api/payment/v1' satisfies typeof PAYMENT_GATEWAY_RELAY_PATH_PREFIX;
const problemContentType = 'application/problem+json' satisfies typeof problemDetailsContentType;

const PaymentGatewayRouteNotFoundWireSchema = TaggedStruct('PaymentGatewayRouteNotFoundProblem', {
  detail: SchemaString,
  status: Literal(404),
  title: SchemaString,
  type: SchemaString,
});
/** The same 404 the Payment relay transport answers for a path outside its typed routes. */
const paymentGatewayRouteNotFoundPayload = PaymentGatewayRouteNotFoundWireSchema.make({
  detail: 'The requested payment gateway route does not exist.',
  status: PaymentGatewayRouteNotFoundWireSchema.fields.status.literal,
  title: 'Payment gateway route not found',
  type: 'https://ontos.dev/problems/payment-gateway-route-not-found',
});

type RouteNotFoundPayload = typeof symmyRouteNotFoundPayload | typeof paymentGatewayRouteNotFoundPayload;

const rejectBatchAlias =
  (payload: RouteNotFoundPayload) =>
  (context: { json: (problem: RouteNotFoundPayload, status: 404, headers: Record<string, string>) => Response }) =>
    context.json(payload, payload.status, {
      'Cache-Control': 'no-store',
      'Content-Type': problemContentType,
    });

/**
 * The framework handles its batch envelope under every mounted BFF prefix before any Effect route policy
 * runs. The Symmy and Payment relay mounts serve only their typed routes, so the alias is refused there.
 */
const integrationMounts: readonly { readonly path: string; readonly payload: RouteNotFoundPayload }[] = [
  { path: symmyRestPrefix, payload: symmyRouteNotFoundPayload },
  { path: paymentGatewayRelayPrefix, payload: paymentGatewayRouteNotFoundPayload },
];

const rejectIntegrationBatchAliases: ReturnType<typeof effectServerPlugin> = {
  name: 'ontos:reject-integration-batch-aliases',
  setup(api) {
    api.onPrepare(() => {
      const prefix = api.getServerConfig()?.bff?.prefix;
      if (!Array.isArray(prefix)) {
        return;
      }
      for (const mount of integrationMounts) {
        if (prefix.includes(mount.path)) {
          api.getServerContext().middlewares.push({
            handler: Fn.flow(
              rejectBatchAlias(mount.payload),
              Promise.resolve.bind<PromiseConstructor, [], [Response], Promise<Response>>(Promise),
            ),
            method: 'all',
            name: `ontos:reject-batch-alias:${mount.path}`,
            order: 'pre',
            path: `${mount.path}${DEFAULT_DATA_BATCH_ENDPOINT}`,
          });
        }
      }
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
  plugins: [rejectIntegrationBatchAliases],
};
