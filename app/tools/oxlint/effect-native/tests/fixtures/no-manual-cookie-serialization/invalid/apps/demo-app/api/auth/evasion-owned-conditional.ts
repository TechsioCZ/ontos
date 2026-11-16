// Same suppression hole through a `Set-Cookie` property: one Cookies-owned branch marks the whole
// property owned, and the hand-built branch is then suppressed as "covered by an outer report".
import { Cookies } from 'effect/unstable/http';

export const respond = (cookies: Cookies.Cookies, name: string, useCookies: boolean): Response =>
  new Response(null, {
    headers: { 'set-cookie': useCookies ? Cookies.toSetCookieHeaders(cookies)[0] : `${name}=; Path=/; HttpOnly` },
  });
