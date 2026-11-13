import { Config, Effect, Option, Schema } from 'effect';

import { shellAuthenticationApiContract } from '../../shared/api.ts';
import type { ShellAuthenticationClientOptions } from '../api/auth-client.ts';

/** Server rendering has no browser document; its BFF reads carry the visitor's cookie and share no browser cache. */
export const isServerRender = (): boolean => !('document' in globalThis);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The Shell's own API on this machine, which the app host derives from its own port (never from a request) for server
 * rendering alone. Server rendering sends the visitor's cookie there, so it must name a loopback host, without
 * credentials or fragment; any other value fails the read.
 */
const ShellRenderApiUrl = Config.schema(
  Schema.URLFromString.check(
    Schema.makeFilter((url) =>
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
        ? undefined
        : 'The Shell render API must be a loopback address without credentials or fragment',
    ),
  ),
  'ONTOS_SHELL_RENDER_API_URL',
);

/** A production process renders only over the host's loopback address: without it the read fails closed. */
const isProduction = Config.String('NODE_ENV').pipe(
  Config.withDefault(''),
  Config.map((environment) => environment === 'production'),
);

/**
 * Where a loader reaches the Shell BFF. Server rendering calls its own process over the loopback address the app host
 * provides: through the public origin every document's reads left the container, crossed the balancer and came back
 * through the host's relay. The BFF answers exactly as for any other request (the same cookie, the same session,
 * context and governed-read checks). Only a development or test process without that address uses the configured
 * public origin, or the document's own; a production process never sends the cookie to an address a request named.
 * The browser keeps its own origin.
 */
const shellApiOrigin = Effect.fn('ShellAuthenticationClientOptions.shellApiOrigin')(function* shellApiOriginEffect(
  request: Request,
) {
  if (isServerRender()) {
    const loopback = yield* Config.option(ShellRenderApiUrl);
    if (Option.isSome(loopback)) {
      return loopback.value.origin;
    }
    if (yield* isProduction) {
      return yield* ShellRenderApiUrl;
    }
  }
  return yield* Config.URL('BETTER_AUTH_URL').pipe(Config.withDefault(new URL(request.url)));
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
