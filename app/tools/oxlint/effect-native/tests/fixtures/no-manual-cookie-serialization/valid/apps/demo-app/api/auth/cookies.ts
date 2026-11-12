import { Effect } from 'effect';
import { Cookies, HttpServerResponse } from 'effect/unstable/http';

declare const parseCookies: (raw: string) => Map<string, string>;

/** Cookie *parsing* is explicitly blessed by the audit ("Existing patterns to preserve"). */
export const readSession = (headers: Headers): string | undefined =>
  parseCookies(headers.get('cookie') ?? '').get('session_token');

export const readRaw = (headers: Headers): string | null => headers.get('set-cookie');

export const setSession = (token: string) =>
  Effect.gen(function* setSessionCookie() {
    return yield* HttpServerResponse.setCookie('session_token', token, {
      httpOnly: true,
      maxAge: 3600,
      path: '/',
      sameSite: 'lax',
      secure: true,
    });
  });

export const clearSession = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setCookie(response, 'session_token', '', { maxAge: 0, path: '/' });

export const forward = (response: HttpServerResponse.HttpServerResponse, raw: readonly string[]) =>
  HttpServerResponse.mergeCookies(response, Cookies.fromSetCookie(raw));

export const writeOwned = (headers: Headers, cookies: Cookies.Cookies): void => {
  headers.append('set-cookie', Cookies.toSetCookieHeaders(cookies)[0] ?? '');
};
