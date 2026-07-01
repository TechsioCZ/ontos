// @effect-diagnostics preferSchemaOverJson:off asyncFunction:off
import {
  defineEffectBff,
  Effect,
  HttpApiBuilder,
  HttpServerResponse,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import {
  getCurrentAuthContext,
  signInDemoUser,
  signOutDemoUser,
} from '@mvp2/core-runtime/auth/demo';
import type { DemoUserKey } from '@mvp2/core-runtime/auth/demo';
import {
  checkModuleStateAdminCapability,
  setTenantModuleState,
} from '@mvp2/core-runtime/module-state';
import { createModuleStateAdminForbidden, shellAuthEffectApi } from '../../src/effect/auth-api.ts';
import { microVerticalGatewayLayer } from './microvertical-gateway.ts';
import { requestHeaders, requireOperationContext } from './request-context.ts';

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
    )
    .handle('setModuleState', ({ payload }) =>
      requestHeaders.pipe(
        Effect.flatMap((headers) =>
          requireOperationContext(headers).pipe(
            Effect.flatMap((operationContext) =>
              Effect.promise(() =>
                checkModuleStateAdminCapability({
                  permission: 'change',
                  principalId: operationContext.principalId,
                  tenantId: operationContext.tenantId,
                }),
              ).pipe(
                Effect.flatMap((canChange) =>
                  canChange
                    ? Effect.promise(async () => {
                        await setTenantModuleState({
                          changedByPrincipalId: operationContext.principalId,
                          moduleKey: payload.moduleKey,
                          newState: payload.state,
                          ...(payload.reason === undefined ? {} : { reason: payload.reason }),
                          tenantId: operationContext.tenantId,
                        });

                        return getCurrentAuthContext({ headers });
                      })
                    : Effect.fail(
                        createModuleStateAdminForbidden(
                          'Module state changes are not allowed for this principal.',
                        ),
                      ),
                ),
              ),
            ),
          ),
        ),
      ),
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
