import { and, eq, gt } from 'drizzle-orm';
import { Context, Crypto, DateTime, Effect, Layer, Option } from 'effect';
import { Hex } from 'effect/encoding';

import { CommercePortalAuthSessionReadUnavailable } from '../../../api/portal-auth/provider/session-read-unavailable.ts';
import { encodeCommerceSessionReference } from '../../../api/portal-auth/provider/session-reference.ts';
import { CommercePortalAuthDatabase } from './portal-auth-database.ts';
import { session, user } from './portal-auth-tables.ts';

/**
 * SHA-256 (hex) of a session's published reference. The reference names the session by its id, never by its token,
 * and only its digest travels as an owner fact, so no evidence or log row can hold the reference itself.
 */
export const portalSessionRefDigestOf = Effect.fn('CommercePortalSession.refDigest')(function* refDigestOf(
  sessionRef: string,
) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(yield* crypto.digest('SHA-256', new TextEncoder().encode(sessionRef)));
});

export interface CommercePortalSessionLivenessService {
  /**
   * Whether the provider subject has a live session with this reference digest now: unexpired, and its account not
   * banned. A signed-out or revoked session no longer exists in the realm, so it is not live.
   */
  readonly isLive: (input: {
    readonly providerSubjectId: string;
    readonly sessionRefDigest: string;
  }) => Effect.Effect<boolean, CommercePortalAuthSessionReadUnavailable>;
}

export class CommercePortalSessionLiveness extends Context.Service<
  CommercePortalSessionLiveness,
  CommercePortalSessionLivenessService
>()(
  '@app/commerce-customer-context/portal-auth/persistence/portal-auth-session-liveness/CommercePortalSessionLiveness',
) {}

/** The realm's sessions could not be read: a session's liveness is then unknown, never assumed. */
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new CommercePortalAuthSessionReadUnavailable({ reason: 'Commerce portal sessions could not be read' }),
    'cause',
    { configurable: true, value: cause },
  );

/** The realm's own reader, over its own database role: the Better Auth token column is never selected. */
export const CommercePortalSessionLivenessLive = Layer.effect(
  CommercePortalSessionLiveness,
  Effect.gen(function* makeLiveness() {
    const { executor } = yield* CommercePortalAuthDatabase;
    const crypto = yield* Crypto.Crypto;
    return {
      isLive: Effect.fn('CommercePortalSessionLiveness.isLive')(function* isLive({
        providerSubjectId,
        sessionRefDigest,
      }) {
        const now = yield* DateTime.nowAsDate;
        const rows = yield* executor
          .select({ banExpiresAt: user.banExpires, banned: user.banned, sessionId: session.id })
          .from(session)
          .innerJoin(user, and(eq(session.userId, user.id), eq(user.id, providerSubjectId), gt(session.expiresAt, now)))
          .pipe(Effect.mapError(unavailable));
        const live = yield* Effect.forEach(
          rows,
          (row) =>
            encodeCommerceSessionReference(row.sessionId).pipe(
              Effect.flatMap((sessionRef) => crypto.digest('SHA-256', new TextEncoder().encode(sessionRef))),
              Effect.map(Hex.encode),
              Effect.map((digest) => {
                const banned = row.banned === true && (row.banExpiresAt === null || row.banExpiresAt > now);
                return !banned && digest === sessionRefDigest;
              }),
              Effect.mapError(unavailable),
            ),
          { concurrency: 1 },
        );
        return Option.isSome(Option.fromUndefinedOr(live.find(Boolean)));
      }),
    };
  }),
);
