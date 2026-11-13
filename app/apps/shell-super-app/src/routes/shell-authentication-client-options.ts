import { Config, Effect, Option, Schema } from 'effect';

import { shellAuthenticationApiContract } from '../../shared/api.ts';
import type { ShellAuthenticationClientOptions } from '../api/auth-client.ts';

/** Server rendering has no browser document; its BFF reads carry the visitor's cookie and share no browser cache. */
export const isServerRender = (): boolean => !('document' in globalThis);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The Shell's own API on this machine, as the app host derives it from its own port (never from a request). Server
 * rendering sends the visitor's cookie there, so it must be plain HTTP to a loopback host or HTTPS, without credentials.
 */
const ShellLoopbackApiBase = Config.schema(
  Schema.URLFromString.check(
    Schema.makeFilter((url) =>
      (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
        ? undefined
        : 'The Shell loopback API requires HTTPS or plain HTTP to a loopback host, without credentials or fragment',
    ),
  ),
  'ONTOS_SHELL_GATEWAY_BASE_URL',
);

/**
 * Where a loader reaches the Shell BFF. Server rendering calls its own process over the loopback address the app host
 * provides: through the public origin every document's reads left the container, crossed the balancer and came back
 * through the host's relay. The BFF answers exactly as for any other request (the same cookie, the same session,
 * context and governed-read checks). Without that address (a development server) it uses the configured public origin.
 */
const shellApiOrigin = Effect.fn('ShellAuthenticationClientOptions.shellApiOrigin')(function* shellApiOriginEffect(
  request: Request,
) {
  const loopback = isServerRender() ? yield* Config.option(ShellLoopbackApiBase) : Option.none<URL>();
  return Option.isSome(loopback)
    ? loopback.value.origin
    : yield* Config.URL('BETTER_AUTH_URL').pipe(Config.withDefault(new URL(request.url)));
});

export const shellAuthenticationClientOptionsFromRequest = (request: Request) =>
  shellApiOrigin(request).pipe(
    Effect.map((origin) => {
      const baseUrl = new URL(shellAuthenticationApiContract.apiPrefix, origin);
      const cookie = request.headers.get('cookie');
      const targetSourcePath = new URL(request.url).pathname;
      return cookie === null ? { baseUrl, targetSourcePath } : { baseUrl, cookie, targetSourcePath };
    }),
  );

/** Better Auth's session cookie, with or without the `__Secure-` prefix the Shell uses over HTTPS. */
const SESSION_COOKIE = /(?:^|;)\s*(?:__Secure-)?better-auth\.session_token=/u;

/**
 * Server rendering of a document that carries no session cookie: the Shell already knows the visitor is anonymous, so
 * it answers without asking its own BFF over the network. In the browser the session cookie is HttpOnly and never
 * visible here, so this never applies there.
 */
export const isServerRenderWithoutSession = (options: ShellAuthenticationClientOptions): boolean =>
  isServerRender() && (options.cookie === undefined || !SESSION_COOKIE.test(options.cookie));
