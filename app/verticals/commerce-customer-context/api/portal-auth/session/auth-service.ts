import { Context } from 'effect';

import type { CommercePortalAuth } from '../provider/auth.ts';

/**
 * Better Auth is a foreign HTTP provider; its Promise surface is supplied by the root layer. Only
 * the typed API is exposed: the raw `auth.handler` proxy is no longer part of this transport.
 */
interface CommercePortalAuthHttpPort {
  readonly api: Pick<CommercePortalAuth['api'], 'changePassword' | 'getSession' | 'signOut'>;
}

/**
 * The tag alone, beside `http.ts` rather than in it, following this folder's `*-service.ts` leaves.
 *
 * An Action that asks for this capability needs the tag and nothing else, while `http.ts` carries the transport, its
 * routes and the session reads that answer them. Keeping them apart stops an Action from dragging the portal's whole
 * HTTP and session layer — and through it `ReadRuntime` — into the Outbox worker's bundle, whose `@app/core-runtime`
 * is the narrow worker surface.
 */
export class CommercePortalAuthService extends Context.Service<CommercePortalAuthService, CommercePortalAuthHttpPort>()(
  '@app/commerce-customer-context/api/portal-auth/session/auth-service/CommercePortalAuthService',
) {}
