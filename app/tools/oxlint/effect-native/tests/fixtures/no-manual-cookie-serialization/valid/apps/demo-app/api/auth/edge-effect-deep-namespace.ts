// Deep submodule namespace imports and aliased named imports are real Effect cookie bindings.
import { Cookies as C } from 'effect/unstable/http';
import * as Respond from 'effect/unstable/http/HttpServerResponse';

export const write = (headers: Headers, cookies: C.Cookies): void => {
  headers.append('set-cookie', C.toSetCookieHeaders(cookies).join(', '));
};

export const respond = (response: Respond.HttpServerResponse, cookies: C.Cookies) =>
  Respond.mergeCookies(response, cookies);
