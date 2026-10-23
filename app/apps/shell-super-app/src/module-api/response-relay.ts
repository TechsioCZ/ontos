/**
 * Response-direction policy for the Shell module-API relay.
 *
 * The request leg deliberately strips cookies and hop-by-hop headers before forwarding to an owner release.
 * The response leg previously had no equivalent: the admitted owner's `Response` was rendered verbatim under
 * the Shell origin, so a module could set cookies for the origin that holds the staff session, send the browser
 * off-origin, or mark a per-principal response cacheable.
 *
 * Everything a module legitimately needs to say about its own payload is content metadata, so the relay
 * carries an explicit allow-list of content headers and always forces a private, non-rendering policy.
 */

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
 * browser (subject to the same-origin rule below), but it may not write cookies for the Shell origin or
 * schedule a navigation of its own.
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
  for (const [name, value] of FORCED_RESPONSE_HEADERS) {
    relayed.push([name, value]);
  }
  return Object.fromEntries(relayed);
};

/**
 * Rebuilds the owner response with the relay policy applied. The body stream is passed through untouched so
 * streaming responses keep working.
 */
export const relayModuleResponse = (response: Response, selfOrigin?: string): Response =>
  new Response(response.body, {
    headers: relayedResponseHeaders(response.headers, selfOrigin),
    status: response.status,
    statusText: response.statusText,
  });
