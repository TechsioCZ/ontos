import { createHmac } from 'node:crypto';

import { Cookies, HttpEffect, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Effect, Option, Redacted, Schema } from 'effect';
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

/**
 * The half of a durable budget key that names the subject an attempt is for — an address, a live
 * session cookie, a pending challenge, a recovery token. It is keyed under the deployment secret,
 * so the durable `rate_limit` rows stay a set of opaque digests rather than a readable list of the
 * portal's customers and the credentials they hold.
 */
export const hashSubjectKey = (subject: string, secret: Redacted.Redacted): string =>
  createHmac('sha256', Redacted.value(secret)).update(subject).digest('base64url');

/** Every request that cannot name a peer shares this key, so an unattributable caller is capped. */
export const UNRESOLVED_PORTAL_AUTH_CLIENT_KEY = 'no-trusted-peer';

/**
 * A `x-forwarded-for` hop is believed only when the peer is a declared proxy, and then only the
 * right-most hop that is not itself one, so a forged header cannot mint its own budget.
 *
 * This vertical is served through a web handler, whose request carries no remote address, so this
 * answers `UNRESOLVED_PORTAL_AUTH_CLIENT_KEY` for every caller: a budget keyed on it alone is one
 * counter for the whole deployment. Every caller must add a subject that bounds what one attempt
 * can deny — the account it names, or the session its own cookie resolves to.
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
