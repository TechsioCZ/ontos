// @effect-diagnostics asyncFunction:off globalFetch:off globalTimers:off -- CIMD's fetch transport is a bounded Promise boundary. expires: 2027-03-31.
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';

export const CIMD_FETCH_TIMEOUT_MS = 5_000;
export const CIMD_MAX_RESPONSE_BYTES = 5 * 1024;

const validateUrl = (url: URL): void => {
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.includes(':') ||
    /^[\d.]+$/u.test(hostname)
  ) {
    throw new TypeError('CIMD requires a public HTTPS hostname');
  }
};

/**
 * Workers egress replaces Node's DNS validation/pinning boundary: Workers own DNS and public-network
 * routing, and Fetch cannot inspect or pin a resolved address. Never bind this fetch to private services,
 * VPC, or a resolveOverride. Literal IPs and localhost are rejected before any network request.
 */
export const fetchClientMetadataResource: ClientMetadataResourceFetch = async (input, init) => {
  const request = new Request(input, init);
  validateUrl(new URL(request.url));
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new TypeError('CIMD supports only GET and HEAD');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) {
    abort();
  }
  const timer = setTimeout(() => controller.abort(new Error('CIMD fetch timed out')), CIMD_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(request, { redirect: 'manual', signal: controller.signal });
    if (response.redirected || (response.status >= 300 && response.status < 400 && response.status !== 304)) {
      await response.body?.cancel();
      throw new TypeError('CIMD redirects are forbidden');
    }
    // The CIMD resolver joins conditional 304s with its validated cache entry.
    if (response.status === 304 || request.method === 'HEAD') {
      await response.body?.cancel();
      return new Response(null, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    }
    if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|\s*$)/iu.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw new TypeError('CIMD resource must be JSON');
    }
    if (Number(response.headers.get('content-length')) > CIMD_MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new TypeError('CIMD resource is too large');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader !== undefined) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          size += value.byteLength;
          if (size > CIMD_MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new TypeError('CIMD resource is too large');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    JSON.parse(new TextDecoder().decode(bytes));
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(bytes, { headers, status: response.status, statusText: response.statusText });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
  }
};
