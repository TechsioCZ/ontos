import { and, eq, isNull } from 'drizzle-orm';
import { Effect, Layer, Option } from 'effect';

import { AuthDatabase } from './client.ts';
import { OAuthCredentials } from './oauth-credentials.ts';
import { OAuthCredentialsUnavailable } from './oauth-credentials-unavailable.ts';
import type { OAuthRefreshFamily } from './oauth-credentials.ts';
import { oauthAccessToken, oauthConsent, oauthRefreshToken, user } from './schema.ts';

const unavailable = (cause: unknown) => new OAuthCredentialsUnavailable({ cause });

/** Captures Auth's private producer once. Core grant/binding writes are deliberately impossible here. */
export const OAuthCredentialsLive = Layer.effect(
  OAuthCredentials,
  Effect.gen(function* oauthCredentialsService() {
    const { executor } = yield* AuthDatabase;
    return {
      loadRefresh: Effect.fn('OAuthCredentials.loadRefresh')(function* loadRefresh(storageKey: string) {
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
          .where(eq(oauthRefreshToken.token, storageKey))
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        return Option.fromNullishOr(row);
      }),
      loadUserAccount: Effect.fn('OAuthCredentials.loadUserAccount')(function* loadUserAccount(userId: string) {
        const [row] = yield* executor
          .select({ banned: user.banned, emailVerified: user.emailVerified, name: user.name })
          .from(user)
          .where(eq(user.id, userId))
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        return Option.map(Option.fromNullishOr(row), (account) => ({ ...account, banned: account.banned === true }));
      }),
      revokeFamily: Effect.fn('OAuthCredentials.revokeFamily')(function* revokeFamily(family: OAuthRefreshFamily) {
        yield* executor
          .transaction(
            Effect.fn('OAuthCredentials.revokeFamilyTransaction')(function* revokeCredentialFamily(transaction) {
              // Re-read the retained token's actual owner; a reference alone is never authority over another family.
              const [retained] = yield* transaction
                .select({ userId: oauthRefreshToken.userId })
                .from(oauthRefreshToken)
                .where(
                  and(
                    eq(oauthRefreshToken.id, family.id),
                    eq(oauthRefreshToken.clientId, family.clientId),
                    family.referenceId === null
                      ? isNull(oauthRefreshToken.referenceId)
                      : eq(oauthRefreshToken.referenceId, family.referenceId),
                  ),
                )
                .for('update');
              if (retained === undefined) {
                return;
              }
              if (family.referenceId === null) {
                yield* transaction
                  .delete(oauthAccessToken)
                  .where(
                    and(eq(oauthAccessToken.refreshId, family.id), eq(oauthAccessToken.clientId, family.clientId)),
                  );
                yield* transaction.delete(oauthRefreshToken).where(eq(oauthRefreshToken.id, family.id));
                return;
              }
              yield* transaction
                .delete(oauthAccessToken)
                .where(
                  and(
                    eq(oauthAccessToken.referenceId, family.referenceId),
                    eq(oauthAccessToken.clientId, family.clientId),
                    eq(oauthAccessToken.userId, retained.userId),
                  ),
                );
              yield* transaction
                .delete(oauthRefreshToken)
                .where(
                  and(
                    eq(oauthRefreshToken.referenceId, family.referenceId),
                    eq(oauthRefreshToken.clientId, family.clientId),
                    eq(oauthRefreshToken.userId, retained.userId),
                  ),
                );
              yield* transaction
                .delete(oauthConsent)
                .where(
                  and(
                    eq(oauthConsent.referenceId, family.referenceId),
                    eq(oauthConsent.clientId, family.clientId),
                    eq(oauthConsent.userId, retained.userId),
                  ),
                );
            }),
          )
          .pipe(Effect.mapError(unavailable));
      }),
    };
  }),
);
