/**
 * Checks the OAuth mount runs before Better Auth (ONTOS-MCP-AUTH-DESIGN.md §2.5, §3.1).
 *
 * - Refresh token reuse. Better Auth 1.7.12 answers a reused refresh token by deleting every refresh token of the
 *   (client, user) pair, so one company's connection would kill the user's other connections with the same app.
 *   Here the token family is the connection grant (`referenceId`): reuse after the 30 s grace revokes that one grant
 *   and writes audit `oauth.token.refresh_reuse`; a token that is merely dead is refused without side effects.
 * - Consent order. A code is issued only after "Povolit přístup" activated the draft grant of this browser session.
 */
import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { jsonb, pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { Clock, Effect } from 'effect';

import { forgetLiveConnection } from '../../oauth-connections/connection-service.ts';
import { findGrant, findSessionGrant, setGrantBindingStatus, setGrantStatus } from '../../oauth-connections/grant-store.ts';
import { AuthDatabase } from '../db/client.ts';
import { oauthAccessToken, oauthConsent, oauthRefreshToken } from '../db/schema.ts';
import type { OAuthEndpointGuards, RefreshTokenVerdict } from './policy.ts';

/** Better Auth stores refresh tokens as unpadded base64url SHA-256 (`storeTokens: 'hashed'`, no prefix). */
export const refreshTokenStorageKey = (token: string): string => createHash('sha256').update(token).digest('base64url');

export interface StoredRefreshToken {
  readonly revoked: Date | null;
  readonly rotatedAt: Date | null;
  readonly rotationReplayExpiresAt: Date | null;
}

/**
 * Pure: `pass` lets Better Auth answer (live token, or a rotated token still inside the replay grace); `dead` is a
 * revoked token that was never rotated; `reused` is a rotated token presented after the grace period.
 */
export const classifyRefreshToken = (row: StoredRefreshToken | undefined, nowMillis: number): RefreshTokenVerdict => {
  if (row === undefined || row.revoked === null) {
    return 'pass';
  }
  if (row.rotatedAt === null) {
    return 'dead';
  }
  return row.rotationReplayExpiresAt !== null && row.rotationReplayExpiresAt.getTime() >= nowMillis ? 'pass' : 'reused';
};

const coreAuditEvents = pgSchema('core').table('audit_events', {
  auditProfile: text('audit_profile').notNull(),
  authBindingId: uuid('auth_binding_id'),
  authMethod: text('auth_method').notNull(),
  eventType: text('event_type').notNull(),
  evidenceJson: jsonb('evidence_json').$type<Readonly<Record<string, unknown>>>().notNull(),
  legalEntityId: uuid('legal_entity_id'),
  outcome: text('outcome').notNull(),
  outcomeCode: text('outcome_code').notNull(),
  outcomeStage: text('outcome_stage').notNull(),
  principalId: uuid('principal_id'),
  targetModuleKey: text('target_module_key'),
  tenantId: uuid('tenant_id').notNull(),
});

/** Revokes the one grant whose rotated refresh token came back, with its tokens and binding, and audits it. */
const revokeReusedGrant = Effect.fn('OAuthEndpointGuards.revokeReusedGrant')(function* revokeReusedGrantEffect(row: {
  readonly clientId: string;
  readonly id: string;
  readonly referenceId: string | null;
  readonly userId: string;
}) {
  const { executor } = yield* AuthDatabase;
  if (row.referenceId === null) {
    // No grant to cut off: drop only this token's own chain member.
    yield* executor.delete(oauthAccessToken).where(eq(oauthAccessToken.refreshId, row.id));
    yield* executor.delete(oauthRefreshToken).where(eq(oauthRefreshToken.id, row.id));
    return;
  }
  const grantId = row.referenceId;
  yield* executor.delete(oauthAccessToken).where(eq(oauthAccessToken.referenceId, grantId));
  yield* executor.delete(oauthRefreshToken).where(eq(oauthRefreshToken.referenceId, grantId));
  yield* executor.delete(oauthConsent).where(eq(oauthConsent.referenceId, grantId));
  const grant = yield* findGrant(grantId);
  if (grant === undefined) {
    return;
  }
  if (grant.status === 'active') {
    yield* setGrantStatus({ grantId, revokedByPrincipalId: null, revokeReason: null, status: 'revoked' });
    if (grant.authBindingId !== null) {
      yield* setGrantBindingStatus({ authBindingId: grant.authBindingId, status: 'disabled', tenantId: grant.tenantId });
    }
  }
  forgetLiveConnection(grantId);
  yield* executor.insert(coreAuditEvents).values({
    auditProfile: 'sensitive',
    authBindingId: grant.authBindingId,
    authMethod: 'oauth_refresh_token',
    eventType: 'oauth.token.refresh_reuse',
    evidenceJson: {
      clientId: row.clientId,
      clientName: grant.clientName,
      grantId,
      grantStatusBefore: grant.status,
      refreshTokenId: row.id,
    },
    legalEntityId: grant.legalEntityId,
    outcome: 'denied',
    outcomeCode: 'refresh_reuse',
    outcomeStage: 'authn',
    principalId: grant.userPrincipalId,
    targetModuleKey: 'core.identity',
    tenantId: grant.tenantId,
  });
});

export interface OAuthGuardSession {
  readonly sessionId: string;
  readonly userId: string;
}

export const makeOAuthEndpointGuards = (input: {
  readonly database: (typeof AuthDatabase)['Service'];
  /** The Better Auth session of the request cookies, or undefined when signed out. */
  readonly readSession: (headers: Headers) => Effect.Effect<OAuthGuardSession | undefined>;
}): OAuthEndpointGuards => {
  const withDatabase = Effect.provideService(AuthDatabase, input.database);
  return {
    consentApproved: (headers) =>
      input.readSession(headers).pipe(
        Effect.flatMap((session) =>
          session === undefined
            ? Effect.succeed(false)
            : findSessionGrant(session).pipe(Effect.map((grant) => grant?.status === 'active')),
        ),
        withDatabase,
        // Fail closed: without a readable grant no code is issued.
        Effect.orElseSucceed(() => false),
      ),
    refreshTokenStatus: (refreshToken, options) =>
      Effect.gen(function* checkRefreshToken() {
        const { executor } = yield* AuthDatabase;
        const [row] = yield* executor
          .select({
            clientId: oauthRefreshToken.clientId,
            id: oauthRefreshToken.id,
            referenceId: oauthRefreshToken.referenceId,
            revoked: oauthRefreshToken.revoked,
            rotatedAt: oauthRefreshToken.rotatedAt,
            rotationReplayExpiresAt: oauthRefreshToken.rotationReplayExpiresAt,
            userId: oauthRefreshToken.userId,
          })
          .from(oauthRefreshToken)
          .where(eq(oauthRefreshToken.token, refreshTokenStorageKey(refreshToken)))
          .limit(1);
        const verdict = classifyRefreshToken(row, yield* Clock.currentTimeMillis);
        if (verdict === 'reused' && row !== undefined && options.revokeOnReuse) {
          yield* revokeReusedGrant(row);
        }
        return verdict;
      }).pipe(
        withDatabase,
        // A lookup failure leaves the decision to Better Auth.
        Effect.orElseSucceed((): RefreshTokenVerdict => 'pass'),
      ),
  };
};
