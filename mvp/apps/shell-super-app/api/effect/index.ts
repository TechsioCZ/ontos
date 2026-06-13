import {
  defineEffectBff,
  Effect,
  HttpApiBuilder,
  HttpServerRequest,
  HttpServerResponse,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import {
  checkModuleStateGate,
  checkModuleWritePermission,
  checkPolicyGate,
  checkProtectedResourceRead,
  getCurrentRuntimeContext,
  signInDemoUser,
  signOutDemoUser,
} from '@mvp/core-runtime';
import type { DemoUserKey } from '@mvp/core-runtime';
import { day3ShellEffectApi, day3ShellOperationContexts } from '@mvp/shared-effect-api';
import type { OperationContext } from '@mvp/shared-effect-api';

const operationAttributes = (operationContext: OperationContext) => ({
  'modernjs.operation.id': operationContext.operationId,
  'modernjs.operation.method': operationContext.method,
  'modernjs.operation.route': operationContext.routePath,
  'modernjs.operation.source': operationContext.source,
});

const withOperationSpan = <A, E, R>(operation: OperationContext, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.withSpan(`ontos.day3.${operation.operationId}`, {
      attributes: operationAttributes(operation),
      kind: 'server',
    }),
  );

const toDemoUserKey = (value: string): DemoUserKey =>
  value === 'demo-viewer-a' || value === 'demo-admin-b' ? value : 'demo-admin-a';

const requestHeaders = HttpServerRequest.HttpServerRequest.pipe(
  Effect.map((request) => new Headers(Object.entries(request.headers))),
);

const sessionCookieHeader = (setCookieHeaders: readonly string[]) =>
  setCookieHeaders.find((header) => header.toLowerCase().includes('session_token=')) ??
  setCookieHeaders.find((header) => header.toLowerCase().includes('session')) ??
  setCookieHeaders.at(-1);

const jsonWithSetCookie = (body: unknown, setCookieHeaders: readonly string[]) =>
  HttpServerResponse.raw(JSON.stringify(body), {
    contentType: 'application/json; charset=utf-8',
    headers:
      setCookieHeaders.length === 0
        ? undefined
        : {
            'set-cookie': sessionCookieHeader(setCookieHeaders),
          },
  });

const day3RuntimeLayer = HttpApiBuilder.group(day3ShellEffectApi, 'day3Runtime', (handlers) =>
  handlers
    .handle('signInDemoUser', ({ payload }) =>
      withOperationSpan(
        day3ShellOperationContexts.signInDemoUser,
        Effect.promise(() =>
          signInDemoUser({ demoUserKey: toDemoUserKey(payload.demoUserKey) }),
        ).pipe(
          Effect.map(({ body, setCookieHeaders }) => jsonWithSetCookie(body, setCookieHeaders)),
        ),
      ),
    )
    .handle('signOutDemoUser', () =>
      withOperationSpan(
        day3ShellOperationContexts.signOutDemoUser,
        requestHeaders.pipe(
          Effect.flatMap((headers) =>
            Effect.promise(() => signOutDemoUser({ headers })).pipe(
              Effect.map(({ body, setCookieHeaders }) => jsonWithSetCookie(body, setCookieHeaders)),
            ),
          ),
        ),
      ),
    )
    .handle('getCurrentRuntimeContext', () =>
      withOperationSpan(
        day3ShellOperationContexts.getCurrentRuntimeContext,
        requestHeaders.pipe(
          Effect.flatMap((headers) => Effect.promise(() => getCurrentRuntimeContext({ headers }))),
        ),
      ),
    )
    .handle('checkModuleWritePermission', ({ payload }) =>
      withOperationSpan(
        day3ShellOperationContexts.checkModuleWritePermission,
        requestHeaders.pipe(
          Effect.flatMap((headers) =>
            Effect.promise(() => checkModuleWritePermission({ ...payload, headers })),
          ),
        ),
      ),
    )
    .handle('checkModuleStateGate', ({ payload }) =>
      withOperationSpan(
        day3ShellOperationContexts.checkModuleStateGate,
        requestHeaders.pipe(
          Effect.flatMap((headers) =>
            Effect.promise(() => checkModuleStateGate({ ...payload, headers })),
          ),
        ),
      ),
    )
    .handle('checkPolicyGate', ({ payload }) =>
      withOperationSpan(
        day3ShellOperationContexts.checkPolicyGate,
        requestHeaders.pipe(
          Effect.flatMap((headers) =>
            Effect.promise(() => checkPolicyGate({ ...payload, headers })),
          ),
        ),
      ),
    )
    .handle('checkProtectedResourceRead', ({ payload }) =>
      withOperationSpan(
        day3ShellOperationContexts.checkProtectedResourceRead,
        requestHeaders.pipe(
          Effect.flatMap((headers) =>
            Effect.promise(() => checkProtectedResourceRead({ ...payload, headers })),
          ),
        ),
      ),
    ),
);

const layer = HttpApiBuilder.layer(day3ShellEffectApi).pipe(Layer.provide(day3RuntimeLayer));

export default defineEffectBff({
  api: day3ShellEffectApi,
  layer,
});
