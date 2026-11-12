import { Cookies as HttpCookies, HttpServerResponse as Respond } from 'effect/unstable/http';
import * as NamespacedCookies from 'effect/unstable/http/Cookies';

export const writeAliased = (headers: Headers, cookies: HttpCookies.Cookies): void => {
  headers.set('Set-Cookie', HttpCookies.toSetCookieHeaders(cookies).join(', '));
};

export const writeNamespaced = (headers: Headers, cookies: NamespacedCookies.Cookies): void => {
  headers.append('set-cookie', NamespacedCookies.toSetCookieHeaders(cookies)[0] ?? '');
};

export const respondWith = (response: Respond.HttpServerResponse, cookies: HttpCookies.Cookies) =>
  Respond.mergeCookies(response, cookies);

export const headersObject = (cookies: HttpCookies.Cookies) => ({
  'content-type': 'application/json',
  'set-cookie': HttpCookies.toSetCookieHeaders(cookies),
});
