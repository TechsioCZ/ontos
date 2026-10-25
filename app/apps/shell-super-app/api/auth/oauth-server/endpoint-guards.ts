/**
 * Checks run before Better Auth. Refresh reuse revokes only the retained grant's token family, never the user's
 * other company connections. The native Auth producer owns credential SQL; Core owns denied observations.
 */
import { createHash } from 'node:crypto';

import { OAuthAuthenticationAudit } from '@app/core-runtime';
import { Clock, Context, Effect, Layer, Option, Redacted } from 'effect';

import { OAuthEndpointGuardData } from '../../oauth-connections/grant-store.ts';
import { OAuthGuardSessions } from './guard-sessions.ts';
import type { OAuthEndpointGuards as OAuthEndpointGuardsContract, RefreshTokenVerdict } from './policy.ts';

/** Better Auth stores refresh tokens as unpadded base64url SHA-256 (`storeTokens: 'hashed'`, no prefix). */
export const refreshTokenStorageKey = (token: string): string => createHash('sha256').update(token).digest('base64url');

export interface StoredRefreshToken {
  readonly revoked: Date | null;
  readonly rotatedAt: Date | null;
  readonly rotationReplayExpiresAt: Date | null;
}

/** `pass`: live/unknown token or replay grace; `dead`: never rotated; `reused`: rotated after grace. */
export const classifyRefreshToken = (row: StoredRefreshToken | undefined, nowMillis: number): RefreshTokenVerdict => {
  if (row === undefined || row.revoked === null) {
    return 'pass';
  }
  if (row.rotatedAt === null) {
    return 'dead';
  }
  return row.rotationReplayExpiresAt !== null && row.rotationReplayExpiresAt.getTime() >= nowMillis ? 'pass' : 'reused';
};

export class OAuthEndpointGuards extends Context.Service<OAuthEndpointGuards, OAuthEndpointGuardsContract>()(
  '@app/shell-super-app/api/auth/oauth-server/endpoint-guards/OAuthEndpointGuards',
) {}

/** Capture real native producers once at authentication composition, not a transport-visible global database. */
const makeOAuthEndpointGuards = Effect.fn('OAuthEndpointGuards.make')(function* makeOAuthEndpointGuards() {
  const data = yield* OAuthEndpointGuardData;
  const audit = yield* OAuthAuthenticationAudit;
  const sessions = yield* OAuthGuardSessions;
  const refreshTokenStatus = Effect.fn('OAuthEndpointGuards.refreshTokenStatus')(
    function* checkRefreshToken(refreshToken: Redacted.Redacted, options: { readonly revokeOnReuse: boolean }) {
      const row = yield* data.loadRefresh(refreshTokenStorageKey(Redacted.value(refreshToken)));
      const verdict = classifyRefreshToken(Option.getOrUndefined(row), yield* Clock.currentTimeMillis);
      if (verdict === 'reused' && Option.isSome(row) && options.revokeOnReuse) {
        const { grant } = row.value;
        const observe = Option.isSome(grant)
          ? audit.record({
              authBindingId: grant.value.authBindingId,
              authMethod: 'oauth_refresh_token',
              eventType: 'oauth.token.refresh_reuse',
              evidence: {
                clientId: row.value.clientId,
                grantStatusBefore: grant.value.status,
                refreshTokenId: row.value.id,
              },
              grant: grant.value,
              outcome: 'denied',
              outcomeCode: 'refresh_reuse',
              principalId: grant.value.userPrincipalId,
            })
          : Effect.void;
        // Cleanup is attempted even if auditing is unavailable; denial is observed after commit/rollback even
        // when cleanup fails. Disabled bindings do not gate this native observer and failures are not swallowed.
        yield* data.revokeFamily(row.value).pipe(Effect.ensuring(observe.pipe(Effect.orDie)));
      }
      return verdict;
    },
    // A failed lookup, observation or cleanup must not enter Better Auth's global refresh-reuse path.
    Effect.orDie,
  );
  return {
    consentApproved: Effect.fn('OAuthEndpointGuards.consentApproved')(
      function* consentApproved(headers: Headers) {
        const session = yield* sessions.read(headers);
        return Option.isNone(session) ? false : yield* data.consentApproved(session.value);
      },
      Effect.orElseSucceed(() => false),
    ),
    refreshTokenStatus,
  } satisfies OAuthEndpointGuardsContract;
});

export const OAuthEndpointGuardsLive = Layer.effect(OAuthEndpointGuards, makeOAuthEndpointGuards());
