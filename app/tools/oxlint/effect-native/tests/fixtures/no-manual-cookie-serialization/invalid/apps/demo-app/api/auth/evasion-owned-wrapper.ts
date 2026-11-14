// The header write is judged "Cookies-owned" because of the `??` left side, so the call is not
// reported — and the hand-built fallback template is suppressed by `isCoveredByOuterReport`,
// which only asks whether a header-write ancestor exists, not whether it was reported.
import { Cookies } from 'effect/unstable/http';

export const write = (headers: Headers, cookies: Cookies.Cookies, name: string): void => {
  headers.append('set-cookie', Cookies.toSetCookieHeaders(cookies)[0] ?? `${name}=; Path=/; Max-Age=0`);
};
