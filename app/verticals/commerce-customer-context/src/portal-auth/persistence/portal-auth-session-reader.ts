import { and, eq } from 'drizzle-orm';
import { Effect, Layer, Option, Schema } from 'effect';

import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  ExternalUserSubjectSchema,
} from '../../../shared/portal-auth-contracts.ts';
import type { CommercePortalAuthAuthoritativeSession } from '../../../api/portal-auth/provider/verification.ts';
import { CommercePortalAuthSessionReaderService } from '../../../api/portal-auth/provider/session-reader-service.ts';
import type { CommercePortalAuthSessionReader } from '../../../api/portal-auth/provider/session-reader-service.ts';
import { CommercePortalAuthSessionReadUnavailable } from '../../../api/portal-auth/provider/session-read-unavailable.ts';
import {
  encodeCommerceSessionReference,
  parseCommerceSessionReference,
} from '../../../api/portal-auth/provider/session-reference.ts';
import { CommercePortalAuthDatabase } from './portal-auth-database.ts';
import type { CommercePortalAuthDatabaseExecutor } from './portal-auth-database-types.ts';
import { session, user } from './portal-auth-tables.ts';

/** Native owner query used by the live verifier. The Better Auth token column is never selected. */
const makeCommercePortalAuthSessionReader = (
  database: CommercePortalAuthDatabaseExecutor,
): CommercePortalAuthSessionReader => ({
  findBySessionId: Effect.fn('CommercePortalAuthSessionReader.findBySessionId')(function* findBySessionId(
    sessionId: string,
  ): Effect.fn.Return<Option.Option<CommercePortalAuthAuthoritativeSession>, CommercePortalAuthSessionReadUnavailable> {
    const rows = yield* database
      .select({
        banExpiresAt: user.banExpires,
        banned: user.banned,
        createdAt: session.createdAt,
        emailVerified: user.emailVerified,
        expiresAt: session.expiresAt,
        providerSubjectId: user.id,
        sessionId: session.id,
      })
      .from(session)
      .innerJoin(user, and(eq(session.userId, user.id), eq(session.id, sessionId)))
      .limit(1)
      .pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(
            new CommercePortalAuthSessionReadUnavailable({
              reason: 'Commerce portal authentication session state could not be read',
            }),
            'cause',
            { configurable: true, value: cause },
          ),
        ),
      );
    const [row] = rows;
    if (row === undefined) {
      return Option.none();
    }

    // Decode the provider identity and namespaced session reference before projecting them into
    // the private reader port. This keeps database output untrusted at the provider boundary.
    const subject = yield* Schema.decodeEffect(ExternalUserSubjectSchema)({
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      providerSubjectId: row.providerSubjectId,
      subjectType: 'user',
    }).pipe(
      Effect.mapError((cause) =>
        Object.defineProperty(
          new CommercePortalAuthSessionReadUnavailable({
            reason: 'Commerce portal authentication returned an invalid provider identity',
          }),
          'cause',
          { configurable: true, value: cause },
        ),
      ),
    );
    const providerSessionReference = yield* encodeCommerceSessionReference(row.sessionId).pipe(
      Effect.mapError((cause) =>
        Object.defineProperty(
          new CommercePortalAuthSessionReadUnavailable({
            reason: 'Commerce portal authentication returned an invalid session identity',
          }),
          'cause',
          { configurable: true, value: cause },
        ),
      ),
    );
    const decodedSessionId = yield* parseCommerceSessionReference(providerSessionReference).pipe(
      Effect.mapError((cause) =>
        Object.defineProperty(
          new CommercePortalAuthSessionReadUnavailable({
            reason: 'Commerce portal authentication returned an invalid session reference',
          }),
          'cause',
          { configurable: true, value: cause },
        ),
      ),
    );
    return Option.some({
      banExpiresAt: row.banExpiresAt,
      banned: row.banned ?? false,
      createdAt: row.createdAt,
      emailVerified: row.emailVerified,
      expiresAt: row.expiresAt,
      providerSubjectId: subject.providerSubjectId,
      sessionId: decodedSessionId,
    });
  }),
});

/** Compose the provider's native database reader through the owner-local Context service. */
export const CommercePortalAuthSessionReaderLive = Layer.effect(
  CommercePortalAuthSessionReaderService,
  Effect.gen(function* makeReaderLayer() {
    const database = yield* CommercePortalAuthDatabase;
    return makeCommercePortalAuthSessionReader(database.executor);
  }),
);
