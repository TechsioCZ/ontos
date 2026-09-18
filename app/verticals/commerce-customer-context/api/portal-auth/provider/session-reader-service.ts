import { Context } from 'effect';

import type { Effect, Option } from 'effect';

import type { CommercePortalAuthAuthoritativeSession } from './verification.ts';
import type { CommercePortalAuthSessionReadUnavailable } from './session-read-unavailable.ts';

/**
 * The reader deliberately has no token member. It can only obtain state by the provider session
 * id parsed from a namespaced Core reference.
 */
export interface CommercePortalAuthSessionReader {
  readonly findBySessionId: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<CommercePortalAuthAuthoritativeSession>, CommercePortalAuthSessionReadUnavailable>;
}

export class CommercePortalAuthSessionReaderService extends Context.Service<
  CommercePortalAuthSessionReaderService,
  CommercePortalAuthSessionReader
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/session-reader-service/CommercePortalAuthSessionReaderService',
) {}
