/**
 * Pure: whether a connect POST comes from the shell itself (design §3.4, CSRF). Browsers send `Origin` on every POST;
 * it must name the request host or the OAuth issuer origin. `Sec-Fetch-Site: cross-site` is refused outright. A
 * request without `Origin` (non-browser client) still needs the session cookie and a JSON body.
 */
export const isSameOriginRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  issuerOrigin: string,
): boolean => {
  if (headers['sec-fetch-site'] === 'cross-site') {
    return false;
  }
  const origin = headers['origin'];
  if (origin === undefined) {
    return true;
  }
  if (origin === issuerOrigin) {
    return true;
  }
  const requestHost = (headers['x-forwarded-host'] ?? headers['host'])?.split(',')[0]?.trim();
  return URL.canParse(origin) && requestHost !== undefined && new URL(origin).host === requestHost;
};
