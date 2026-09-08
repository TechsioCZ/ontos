/**
 * FALSE POSITIVE repro (adversarial review).
 *
 * Real shape: `apps/shell-super-app/api/auth/service.ts:86` (and :91 :97 :103 :111 :117 :121 :130
 * :139 :149 :159 :166) with its consumer `apps/shell-super-app/api/index.ts:128-135`.
 *
 * Nothing here is hand-owned serialization:
 * - The strings are produced by better-auth via the platform `Headers.getSetCookie()`.
 * - `readonly string[]` is the documented input of the blessed Effect API
 *   `Cookies.fromSetCookie: (headers: Iterable<string> | string) => Cookies`
 *   (node_modules/effect/dist/unstable/http/Cookies.d.ts:174).
 * - The HTTP boundary already applies `HttpServerResponse.mergeCookies(Cookies.fromSetCookie(...))`,
 *   i.e. the exact target state the rule's message asks for.
 *
 * The `cookieStringContract` detector still reports the interface property, claiming the contract
 * "forces hand-built cookie strings at the producer" — here the producer is the auth framework.
 */
import { Cookies, HttpServerResponse } from 'effect/unstable/http';

declare const authApi: {
  readonly signIn: (headers: Headers) => Promise<{ readonly headers: Headers }>;
};

export interface AuthenticationResult {
  readonly setCookieHeaders: readonly string[];
}

export const signIn = async (requestHeaders: Headers): Promise<AuthenticationResult> => {
  const result = await authApi.signIn(requestHeaders);
  return { setCookieHeaders: result.headers.getSetCookie() };
};

export const forwardSetCookieHeaders = (
  response: HttpServerResponse.HttpServerResponse,
  result: AuthenticationResult,
) => response.pipe(HttpServerResponse.mergeCookies(Cookies.fromSetCookie(result.setCookieHeaders)));
