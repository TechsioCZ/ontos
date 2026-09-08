// `isCookieNamespaceMember` falls back to the raw identifier name when the binding is unknown, so
// any local/vendored value named `Cookies` or `HttpServerResponse` silences the header-write check
// even though nothing here comes from `effect/unstable/http`.
import { Cookies } from './hand-rolled-cookies.ts';

declare const HttpServerResponse: { readonly setCookie: (name: string, value: string) => string };

export const write = (headers: Headers, name: string, value: string): void => {
  headers.append('set-cookie', Cookies.serialize(name, value));
  headers.set('Set-Cookie', HttpServerResponse.setCookie(name, value));
};
