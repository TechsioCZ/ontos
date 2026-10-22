import { Config, Effect } from 'effect';

import { ssrBffFetch } from '#ssr-bff-fetch';

import { shellAuthenticationApiContract } from '../../shared/api.ts';
import type { ShellAuthenticationClientOptions } from '../api/auth-client.ts';

export const shellAuthenticationClientOptionsFromRequest = (request: Request) =>
  Config.URL('BETTER_AUTH_URL').pipe(
    Config.withDefault(new URL(request.url)),
    Effect.map((configuredOrigin) => {
      const baseUrl = new URL(shellAuthenticationApiContract.apiPrefix, configuredOrigin);
      const cookie = request.headers.get('cookie');
      const fetch = ssrBffFetch();
      const withCookie = cookie === null ? { baseUrl } : { baseUrl, cookie };
      return fetch === undefined ? withCookie : { ...withCookie, fetch };
    }),
  );

/** Server rendering has no browser document; its BFF reads carry the visitor's cookie and share no browser cache. */
export const isServerRender = (): boolean => !('document' in globalThis);

/** Better Auth's session cookie, with or without the `__Secure-` prefix the Shell uses over HTTPS. */
const SESSION_COOKIE = /(?:^|;)\s*(?:__Secure-)?better-auth\.session_token=/u;

/**
 * Server rendering of a document that carries no session cookie: the Shell already knows the visitor is anonymous, so
 * it answers without asking its own BFF over the network. In the browser the session cookie is HttpOnly and never
 * visible here, so this never applies there.
 */
export const isServerRenderWithoutSession = (options: ShellAuthenticationClientOptions): boolean =>
  isServerRender() && (options.cookie === undefined || !SESSION_COOKIE.test(options.cookie));
