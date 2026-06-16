import {
  defineEffectBff,
  Effect,
  HttpApiBuilder,
  HttpServerRequest,
  HttpServerResponse,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import { getCurrentAuthContext, signInDemoUser, signOutDemoUser } from '@mvp2/core-runtime';
import type { DemoUserKey } from '@mvp2/core-runtime';
import { shellAuthEffectApi } from '../../src/effect/auth-api.ts';

const requestHeaders = HttpServerRequest.HttpServerRequest.pipe(
  Effect.map((request) => new Headers(Object.entries(request.headers))),
);

const sessionCookieHeader = (setCookieHeaders: readonly string[]) =>
  setCookieHeaders.find((header) => header.toLowerCase().includes('better-auth.session')) ??
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
            Effect.map(({ body, setCookieHeaders }) => jsonWithSetCookie(body, setCookieHeaders)),
          ),
        ),
      ),
    )
    .handle('signOut', () =>
      requestHeaders.pipe(
        Effect.flatMap((headers) =>
          Effect.promise(() => signOutDemoUser({ headers })).pipe(
            Effect.map(({ body, setCookieHeaders }) => jsonWithSetCookie(body, setCookieHeaders)),
          ),
        ),
      ),
    ),
);

const layer = HttpApiBuilder.layer(shellAuthEffectApi).pipe(Layer.provide(shellAuthLayer));

export default defineEffectBff({
  api: shellAuthEffectApi,
  layer,
});
