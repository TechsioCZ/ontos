import { Cookies, HttpEffect, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Effect, Option, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';

import { CommercePortalAuthConfig } from './provider/config-service.ts';

/** The HttpApi request exposes headers as a decoded record; Better Auth reads a platform `Headers`. */
const CommercePortalAuthRequestHeadersSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Undefined]),
);
export type CommercePortalAuthRequestHeaders = Schema.Schema.Type<typeof CommercePortalAuthRequestHeadersSchema>;

/**
 * Provider cookies reach the browser through the response hook. No portal-auth transport builds a
 * `Response`, so the HttpApi encoder stays the single writer of the body and status.
 */
export const forwardSetCookieHeaders = (headers: readonly string[]) =>
  headers.length === 0
    ? Effect.void
    : HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(response.pipe(HttpServerResponse.mergeCookies(Cookies.fromSetCookie(headers)))),
      );

/** Every portal-auth answer is a live credential decision and must never be cached or stored. */
export const noStoreHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeader(
      HttpServerResponse.setHeader(response, 'cache-control', 'no-store'),
      'pragma',
      'no-cache',
    ),
  ),
);

/** Better Auth answers with the platform `Headers`, which already splits its own `Set-Cookie` list. */
export const providerSetCookieHeaders = (headers: Headers): readonly string[] => headers.getSetCookie();

export const requestHeaders = (headers: CommercePortalAuthRequestHeaders): Headers => {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result.append(name, value);
    }
  }
  return result;
};

/** Every request that cannot name a peer shares this key, so an unattributable caller is capped. */
export const UNRESOLVED_PORTAL_AUTH_CLIENT_KEY = 'no-trusted-peer';

/**
 * The durable budget key must name something the caller cannot choose. The socket peer is that
 * value: a `x-forwarded-for` hop is believed only when the peer is one of the deployment's own
 * declared proxies, and then only the right-most hop that is not itself a declared proxy — the
 * address the outermost trusted proxy actually observed. With no proxy declared, a forged header
 * is ignored entirely rather than minting its own budget.
 *
 * A caller that cannot be attributed is capped, not exempted — but note what "capped" means when
 * the transport observes no peer at all. This vertical is served through a web handler
 * (`HttpRouter.toWebHandler`), and `HttpServerRequest.fromWeb` constructs its request without a
 * remote address, so `request.remoteAddress` is `None` for every request and this function answers
 * `UNRESOLVED_PORTAL_AUTH_CLIENT_KEY` for every caller. A budget keyed on this value *alone* is
 * therefore one counter for the whole deployment, which any single caller can spend. Each caller
 * must add a value that bounds what one attempt can deny — the account the attempt names, or the
 * session its own cookie resolves to — so that spending the budget denies that subject and not
 * every customer.
 */
export const resolveClientKey = (
  request: HttpServerRequest.HttpServerRequest,
  trustedProxies: readonly string[],
): string => {
  const peer = Option.getOrUndefined(request.remoteAddress);
  if (peer === undefined || peer.length === 0) {
    return UNRESOLVED_PORTAL_AUTH_CLIENT_KEY;
  }
  const trusted = new Set(trustedProxies);
  if (!trusted.has(peer)) {
    return peer;
  }
  const chain = (request.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  return chain.findLast((hop) => !trusted.has(hop)) ?? peer;
};

const matchesTrustedOrigin = (value: string, trustedOrigins: readonly string[]): boolean => {
  try {
    const { origin } = new URL(value);
    return trustedOrigins.some((candidate) => {
      try {
        return new URL(candidate).origin === origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
};

/**
 * The deployment-composed trusted origins are the CSRF authority for every state-changing
 * portal-auth route: the transport CORS layer does not cover them and an absent list never falls
 * back to provider defaults. Each group supplies its own forbidden problem value.
 */
export const requireTrustedOrigin = Effect.fn('CommercePortalAuthHttpTransport.requireTrustedOrigin')(
  function* requireTrustedOrigin<Problem>(headers: CommercePortalAuthRequestHeaders, untrusted: () => Problem) {
    const configuration = yield* CommercePortalAuthConfig;
    const { origin } = headers;
    return origin === undefined || origin === 'null' || !matchesTrustedOrigin(origin, configuration.trustedOrigins)
      ? yield* Effect.fail(untrusted())
      : yield* Effect.void;
  },
);
