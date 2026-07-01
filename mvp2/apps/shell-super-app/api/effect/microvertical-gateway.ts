// @effect-diagnostics processEnv:off globalFetchInEffect:off globalConsole:off asyncFunction:off
import {
  Effect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from '@modern-js/plugin-bff/effect-edge';
import { createVerticalGatewayToken } from '@mvp2/core-runtime/gateway-token';
import { checkModuleStateAccess } from '@mvp2/core-runtime/module-state';
import type { ModuleStateAccessDecision } from '@mvp2/core-runtime/module-state';
import type { InstalledModuleKey } from '@mvp2/shared-contracts';
import { createOperationContextAuthRequired } from '../../src/effect/auth-api.ts';
import { currentOperationContext } from './request-context.ts';

interface VerticalRoute {
  readonly audience: InstalledModuleKey;
  readonly targetBaseUrl: string;
}

const verticalRegistry = {
  accounting: {
    audience: 'accounting',
    targetBaseUrl: (
      process.env['VERTICAL_ACCOUNTING_BFF_URL'] ?? 'http://localhost:4102/accounting-api'
    ).replace(/\/+$/u, ''),
  },
  properties: {
    audience: 'properties',
    targetBaseUrl: (
      process.env['VERTICAL_PROPERTIES_BFF_URL'] ?? 'http://localhost:4101/properties-api'
    ).replace(/\/+$/u, ''),
  },
} as const satisfies Record<string, VerticalRoute>;

type VerticalId = keyof typeof verticalRegistry;

interface MicroVerticalGatewayFailed {
  readonly _tag: 'MicroVerticalGatewayFailed';
  readonly message: string;
}

interface MicroVerticalUnavailable {
  readonly _tag: 'MicroVerticalUnavailable';
  readonly message: string;
}

const microVerticalGatewayFailed = (message: string): MicroVerticalGatewayFailed => ({
  _tag: 'MicroVerticalGatewayFailed',
  message,
});

const microVerticalUnavailable = (message: string): MicroVerticalUnavailable => ({
  _tag: 'MicroVerticalUnavailable',
  message,
});

const authRequiredResponse = (message: string) =>
  HttpServerResponse.jsonUnsafe(createOperationContextAuthRequired(message), {
    status: 401,
  });

const gatewayFailedResponse = (message: string) =>
  HttpServerResponse.jsonUnsafe(microVerticalGatewayFailed(message), {
    status: 502,
  });

const gatewayUnavailableResponse = (message: string) =>
  HttpServerResponse.jsonUnsafe(microVerticalUnavailable(message), {
    status: 403,
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

const requestSearch = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.url, 'http://localhost').search;

const targetUrl = ({
  request,
  targetBaseUrl,
  wildcardPath,
}: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly targetBaseUrl: string;
  readonly wildcardPath: string | undefined;
}) => `${targetBaseUrl}/${(wildcardPath ?? '').replace(/^\/+/u, '')}${requestSearch(request)}`;

const forwardMicroVerticalRequest = ({
  operationContextToken,
  request,
  targetBaseUrl,
  wildcardPath,
}: {
  readonly operationContextToken: string;
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly targetBaseUrl: string;
  readonly wildcardPath: string | undefined;
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
        globalThis.fetch(targetUrl({ request, targetBaseUrl, wildcardPath }), {
          headers: forwardedHeaders(request.headers, operationContextToken),
          method: request.method,
          ...(body === undefined ? {} : { body }),
        }),
    });

    return HttpServerResponse.fromWeb(response);
  });

const logGatewayDenied = ({
  decision,
  principalId,
  tenantId,
}: {
  readonly decision: Extract<ModuleStateAccessDecision, { readonly _tag: 'Denied' }>;
  readonly principalId: string;
  readonly tenantId: string;
}) => {
  console.warn(
    JSON.stringify({
      accessKind: decision.accessKind,
      moduleKey: decision.moduleKey,
      outcomeCode: decision.outcomeCode,
      principalId,
      state: decision.state,
      tenantId,
      type: 'module_state.gateway_denied',
    }),
  );
};

export const microVerticalGatewayLayer = HttpRouter.add('*', '/mv/:vertical/*', (request) =>
  HttpRouter.params.pipe(
    Effect.flatMap((params) => {
      const { vertical } = params;
      const route = verticalRegistry[vertical as VerticalId];

      if (vertical === undefined || route === undefined) {
        return Effect.succeed(gatewayFailedResponse('Unknown microvertical.'));
      }

      return currentOperationContext.pipe(
        Effect.flatMap((operationContext) =>
          Effect.promise(async () => {
            const decision = await checkModuleStateAccess({
              accessKind: 'load',
              moduleKey: route.audience,
              tenantId: operationContext.tenantId,
            });

            if (decision._tag === 'Denied') {
              logGatewayDenied({
                decision,
                principalId: operationContext.principalId,
                tenantId: operationContext.tenantId,
              });
            }

            return decision;
          }).pipe(
            Effect.flatMap((decision) =>
              decision._tag === 'Denied'
                ? Effect.succeed(
                    gatewayUnavailableResponse(
                      `Module "${decision.moduleKey}" is not available in state "${decision.state}".`,
                    ),
                  )
                : forwardMicroVerticalRequest({
                    operationContextToken: createVerticalGatewayToken({
                      audience: route.audience,
                      operationContext,
                    }),
                    request,
                    targetBaseUrl: route.targetBaseUrl,
                    wildcardPath: params['*'],
                  }),
            ),
          ),
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
