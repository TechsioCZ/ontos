import { Context, Effect, Layer, Option } from 'effect';

import type { BetterAuthDispatcher } from '../better-auth-provider-types.ts';
import { withAuthenticationTimeout } from '../observability.ts';

export interface OAuthGuardSession {
  readonly sessionId: string;
  readonly userId: string;
}

/** Request-owned SDK session reader; endpoint policy consumes only the minimal session identity. */
export class OAuthGuardSessions extends Context.Service<
  OAuthGuardSessions,
  {
    readonly read: (headers: Headers) => Effect.Effect<Option.Option<OAuthGuardSession>>;
  }
>()('@app/shell-super-app/api/auth/oauth-server/guard-sessions/OAuthGuardSessions') {}

/** Adapt the SDK's real session read through the serving request's native dispatcher. */
export const OAuthGuardSessionsLive = (callAuth: BetterAuthDispatcher) =>
  Layer.succeed(OAuthGuardSessions, {
    read: (requestHeaders) =>
      callAuth((provider) =>
        Effect.tryPromise((provider.api.getSession<false, false>).bind(provider.api, { headers: requestHeaders })).pipe(
          withAuthenticationTimeout('session.read', requestHeaders),
        ),
      ).pipe(
        Effect.map((result) =>
          Option.map(Option.fromNullishOr(result), (session) => ({
            sessionId: session.session.id,
            userId: session.user.id,
          })),
        ),
        // A provider failure is not an anonymous session; retain it at the owning HTTP error boundary.
        Effect.orDie,
      ),
  });
