/**
 * Pure: whether a state-changing POST comes from the shell itself (design §3.4, CSRF). Browsers send `Origin` on every
 * POST; it must name the request host or the OAuth issuer origin. `Sec-Fetch-Site: cross-site` is refused outright.
 * Without `Origin`, only `Sec-Fetch-Site: same-origin` is accepted, so a cookie-carrying request that names no origin
 * at all is refused too.
 */
export const isSameOriginRequest = (
  headers: {
    readonly host?: string | undefined;
    readonly origin?: string | undefined;
    readonly 'sec-fetch-site'?: string | undefined;
    readonly 'x-forwarded-host'?: string | undefined;
  },
  issuerOrigin: string,
): boolean => {
  if (headers['sec-fetch-site'] === 'cross-site') {
    return false;
  }
  const { origin } = headers;
  if (origin === undefined) {
    return headers['sec-fetch-site'] === 'same-origin';
  }
  if (origin === issuerOrigin) {
    return true;
  }
  const requestHost = (headers['x-forwarded-host'] ?? headers.host)?.split(',')[0]?.trim();
  return URL.canParse(origin) && requestHost !== undefined && new URL(origin).host === requestHost;
};
