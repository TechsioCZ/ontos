// @effect-diagnostics preferSchemaOverJson:off processEnv:off globalFetchInEffect:off
import {
  defineEffectBff,
  Effect,
  HttpApiBuilder,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import {
  createVerticalGatewayToken,
  getCurrentAuthContext,
  resolveOperationContextFromSession,
  signInDemoUser,
  signOutDemoUser,
} from '@mvp2/core-runtime';
import type { DemoUserKey } from '@mvp2/core-runtime';
import {
  createOperationContextAuthRequired,
  shellAuthEffectApi,
} from '../../src/effect/auth-api.ts';

const verticalRegistry = {
  properties: {
    audience: 'properties',
    targetBaseUrl: (
      process.env['VERTICAL_PROPERTIES_BFF_URL'] ?? 'http://localhost:4101/properties-api'
    ).replace(/\/+$/u, ''),
  },
} as const;

type VerticalId = keyof typeof verticalRegistry;

interface MicroVerticalGatewayFailed {
  readonly _tag: 'MicroVerticalGatewayFailed';
  readonly message: string;
}

const microVerticalGatewayFailed = (message: string): MicroVerticalGatewayFailed => ({
  _tag: 'MicroVerticalGatewayFailed',
  message,
});

const requestHeaders = HttpServerRequest.HttpServerRequest.pipe(
  Effect.map((request) => new globalThis.Headers(Object.entries(request.headers))),
);

const sessionCookieHeader = (setCookieHeaders: readonly string[]) =>
  setCookieHeaders.find((header) => header.toLowerCase().includes('better-auth.session')) ??
  setCookieHeaders.find((header) => header.toLowerCase().includes('session')) ??
  setCookieHeaders.at(-1);

const jsonWithSetCookie = (body: unknown, setCookieHeaders: readonly string[]) =>
  Effect.sync(() => {
    const setCookie = sessionCookieHeader(setCookieHeaders);

    return HttpServerResponse.raw(JSON.stringify(body), {
      contentType: 'application/json; charset=utf-8',
      ...(setCookie === undefined
        ? {}
        : {
            headers: {
              'set-cookie': setCookie,
            },
          }),
    });
  });

const shellAuthLayer = HttpApiBuilder.group(shellAuthEffectApi, 'auth', (handlers) =>
  handlers
    .handle('context', () =>
      requestHeaders.pipe(
        Effect.flatMap((headers) => Effect.promise(() => getCurrentAuthContext({ headers }))),
      ),
    )
    .handle('signIn', ({ payload }) =>
      requestHeaders.pipe(
        Effect.flatMap((headers) =>
          Effect.promise(() =>
            signInDemoUser({
              demoUserKey: payload.demoUserKey as DemoUserKey,
              headers,
            }),
          ).pipe(
            Effect.flatMap(({ body, setCookieHeaders }) =>
              jsonWithSetCookie(body, setCookieHeaders),
            ),
          ),
        ),
      ),
    )
    .handle('signOut', () =>
      requestHeaders.pipe(
        Effect.flatMap((headers) =>
          Effect.promise(() => signOutDemoUser({ headers })).pipe(
            Effect.flatMap(({ body, setCookieHeaders }) =>
              jsonWithSetCookie(body, setCookieHeaders),
            ),
          ),
        ),
      ),
    ),
);

const makeOperationContext = requestHeaders.pipe(
  Effect.flatMap((headers) =>
    Effect.promise(() => resolveOperationContextFromSession({ headers })).pipe(
      Effect.flatMap((result) =>
        result._tag === 'Success'
          ? Effect.succeed(result.operationContext)
          : Effect.fail(createOperationContextAuthRequired(result.error.message)),
      ),
    ),
  ),
);

const authRequiredResponse = (message: string) =>
  HttpServerResponse.jsonUnsafe(createOperationContextAuthRequired(message), {
    status: 401,
  });

const gatewayFailedResponse = (message: string) =>
  HttpServerResponse.jsonUnsafe(microVerticalGatewayFailed(message), {
    status: 502,
  });

const browserIdentityHeaders = new Set([
  'authorization',
  'content-length',
  'cookie',
  'host',
  'x-legal-entity',
  'x-ontos-operation-context',
  'x-tenant',
  'x-user',
]);

const forwardedHeaders = (
  headers: Readonly<Record<string, string>>,
  operationContextToken: string,
) => {
  const nextHeaders = new globalThis.Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (!browserIdentityHeaders.has(key.toLowerCase())) {
      nextHeaders.set(key, value);
    }
  }

  nextHeaders.set('x-ontos-operation-context', operationContextToken);

  return nextHeaders;
};

const canHaveBody = (method: string) => !['GET', 'HEAD'].includes(method.toUpperCase());

const targetUrl = ({
  targetBaseUrl,
  wildcardPath,
}: {
  targetBaseUrl: string;
  wildcardPath: string | undefined;
}) => `${targetBaseUrl}/${(wildcardPath ?? '').replace(/^\/+/u, '')}`;

const forwardMicroVerticalRequest = ({
  operationContextToken,
  request,
  targetBaseUrl,
  wildcardPath,
}: {
  operationContextToken: string;
  request: HttpServerRequest.HttpServerRequest;
  targetBaseUrl: string;
  wildcardPath: string | undefined;
}): Effect.Effect<HttpServerResponse.HttpServerResponse, MicroVerticalGatewayFailed> =>
  Effect.gen(function* forwardMicroVerticalRequestEffect() {
    const body = canHaveBody(request.method)
      ? yield* request.arrayBuffer.pipe(
          Effect.mapError((error) =>
            microVerticalGatewayFailed(`Microvertical request body read failed: ${String(error)}`),
          ),
        )
      : undefined;
    const response = yield* Effect.tryPromise({
      catch: (error) =>
        microVerticalGatewayFailed(`Microvertical request failed: ${String(error)}`),
      try: () =>
        globalThis.fetch(targetUrl({ targetBaseUrl, wildcardPath }), {
          headers: forwardedHeaders(request.headers, operationContextToken),
          method: request.method,
          ...(body === undefined ? {} : { body }),
        }),
    });

    return HttpServerResponse.fromWeb(response);
  });

const microVerticalGatewayLayer = HttpRouter.add('*', '/mv/:vertical/*', (request) =>
  HttpRouter.params.pipe(
    Effect.flatMap((params) => {
      const { vertical } = params;
      const route = verticalRegistry[vertical as VerticalId];

      if (vertical === undefined || route === undefined) {
        return Effect.succeed(gatewayFailedResponse('Unknown microvertical.'));
      }

      return makeOperationContext.pipe(
        Effect.flatMap((operationContext) =>
          forwardMicroVerticalRequest({
            operationContextToken: createVerticalGatewayToken({
              audience: route.audience,
              operationContext,
            }),
            request,
            targetBaseUrl: route.targetBaseUrl,
            wildcardPath: params['*'],
          }),
        ),
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This is Effect.catchTags, not Promise.catch.
        Effect.catchTags({
          MicroVerticalGatewayFailed: (error) =>
            Effect.succeed(gatewayFailedResponse(error.message)),
          OperationContextAuthRequired: (error) =>
            Effect.succeed(authRequiredResponse(error.message)),
        }),
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      );
    }),
  ),
);

const layer = Layer.mergeAll(
  HttpApiBuilder.layer(shellAuthEffectApi).pipe(Layer.provide(shellAuthLayer)),
  microVerticalGatewayLayer,
);

export default defineEffectBff({
  api: shellAuthEffectApi,
  layer,
});
