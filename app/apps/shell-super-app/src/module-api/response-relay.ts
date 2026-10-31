/**
 * Response-direction policy for the Shell module-API relay.
 *
 * Both legs strip cookies by default; only exact realm cookie names and routes from the admitted owner's
 * reviewed contract may cross. Response cookies additionally retain a host-only, HttpOnly, same-site scope.
 * The relay carries an explicit allow-list of content headers and always forces a private, non-rendering
 * policy, so an owner cannot overwrite the staff realm, send the browser off-origin or cache principal data.
 */

const MAX_OWNER_PHASES = 64;
const MAX_OWNER_HEADER_LENGTH = 4096;
// Mirror Core's fixed ReadPhase names without importing another deployment's private implementation.
const ownerPhase =
  /^(?<phase>read-authentication|read-admission|read-scope|read-module|read-permission|read-prepare|read-transaction|read-authority|read-rls|read-owner|read-validation|read-audit|read-encode)\s*;\s*dur=(?<duration>\d+(?:\.\d+)?)$/u;

// Commas inside quoted descriptions are data, never metric separators (including escaped quotes).
const timingMetrics = (header: string): readonly string[] => {
  const metrics: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ',') {
      metrics.push(header.slice(start, index));
      if (metrics.length === MAX_OWNER_PHASES) {
        return metrics;
      }
      start = index + 1;
    }
  }
  if (quoted) {
    return [];
  }
  metrics.push(header.slice(start));
  return metrics;
};

/** Shared with the gateway collector: only fixed-name, finite numeric owner metrics may cross either boundary. */
export const ownerServerTimings = (header: string): readonly string[] => {
  if (header.length > MAX_OWNER_HEADER_LENGTH) {
    return [];
  }
  const timings: string[] = [];
  for (const metric of timingMetrics(header)) {
    const groups = ownerPhase.exec(metric.trim())?.groups;
    if (groups !== undefined && Number.isFinite(Number(groups['duration']))) {
      timings.push(`${groups['phase']};dur=${groups['duration']}`);
    }
  }
  return timings;
};

const RELAYED_RESPONSE_HEADERS = [
  'accept-ranges',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
  'location',
  'retry-after',
  // A 401 from an owner release carries its own authentication challenge. Dropping it leaves the status
  // without the challenge that tells the caller how to authenticate.
  'www-authenticate',
] as const;

/**
 * Headers that must never cross the relay, whatever the owner release asks for. An owner may still redirect the
 * browser (subject to the same-origin rule below), but generic response headers cannot write cookies or
 * schedule a navigation. Reviewed realm cookies use the separate scoped path below.
 */
export const BLOCKED_RESPONSE_HEADERS: readonly string[] = Object.freeze(['refresh', 'set-cookie', 'set-cookie2']);

/** A response from an owner release is data, never a document: it must not render as active content. */
const FORCED_RESPONSE_HEADERS: readonly (readonly [string, string])[] = Object.freeze([
  ['cache-control', 'no-store'],
  ['content-security-policy', "default-src 'none'; sandbox"],
  ['vary', 'authorization'],
  ['x-content-type-options', 'nosniff'],
]);

/**
 * `location` is relayed only when it stays on the Shell origin. A relative value is resolved against the
 * request origin, so it can only point at this deployment; an absolute value must match that origin exactly.
 */
const isSameOriginOrRelative = (value: string, selfOrigin: string | undefined): boolean => {
  if (selfOrigin === undefined) {
    return false;
  }
  try {
    // Resolving against the request origin also covers protocol-relative values: `//host/path` becomes a
    // different origin and is dropped, while `/path` stays on this deployment.
    return new URL(value, selfOrigin).origin === selfOrigin;
  } catch {
    return false;
  }
};

export const relayedResponseHeaders = (headers: Headers, selfOrigin?: string) => {
  const relayed = RELAYED_RESPONSE_HEADERS.flatMap((name): [string, string][] => {
    const value = headers.get(name);
    if (BLOCKED_RESPONSE_HEADERS.includes(name) || value === null) {
      return [];
    }
    if (name === 'location' && !isSameOriginOrRelative(value, selfOrigin)) {
      return [];
    }
    return [[name, value]];
  });
  const ownerTiming = ownerServerTimings(headers.get('server-timing') ?? '').join(', ');
  if (ownerTiming.length > 0) {
    relayed.push(['server-timing', ownerTiming]);
  }
  for (const [name, value] of FORCED_RESPONSE_HEADERS) {
    relayed.push([name, value]);
  }
  return Object.fromEntries(relayed);
};

/** Names come only from admission of the exact owner, method and route, never from response headers. */
const isScopedRealmCookie = (cookie: string, names: readonly string[]): boolean => {
  const [pair = '', ...parts] = cookie.split(';');
  const separator = pair.indexOf('=');
  const name = pair.slice(0, separator);
  if (separator < 1 || !names.includes(name)) {
    return false;
  }
  const attributes = new Map<string, string>();
  for (const part of parts) {
    const [key = '', ...value] = part.trim().split('=');
    const normalizedKey = key.trim().toLowerCase();
    if (attributes.has(normalizedKey)) {
      return false;
    }
    attributes.set(normalizedKey, value.join('=').trim());
  }
  return (
    !attributes.has('domain') &&
    attributes.get('path') === '/' &&
    attributes.get('httponly') === '' &&
    ['lax', 'strict'].includes(attributes.get('samesite')?.toLowerCase() ?? '') &&
    (!/^__(?:Secure|Host)-/u.test(name) || attributes.get('secure') === '')
  );
};

/**
 * Rebuilds the owner response with the relay policy applied. The body stream is passed through untouched so
 * streaming responses keep working.
 */
export const relayModuleResponse = (
  response: Response,
  selfOrigin?: string,
  responseCookieNames: readonly string[] = [],
): Response => {
  const headers = Object.entries(relayedResponseHeaders(response.headers, selfOrigin));
  for (const cookie of response.headers.getSetCookie()) {
    if (isScopedRealmCookie(cookie, responseCookieNames)) {
      headers.push(['set-cookie', cookie]);
    }
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};
