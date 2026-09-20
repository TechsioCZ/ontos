import { and, eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import { CommercePortalAuthAccountCreationUnavailable } from '../../../api/portal-auth/provider/account-creation-unavailable.ts';
import { CommercePortalAuthAccountLookupService } from '../../../api/portal-auth/provider/account-lookup-service.ts';
import type { CommercePortalAuthAccountLookup } from '../../../api/portal-auth/provider/account-lookup-service.ts';
import { normalizeCommercePortalAuthEmail } from '../email-normalization.ts';
import { CommercePortalAuthDatabase } from './portal-auth-database.ts';
import type { CommercePortalAuthDatabaseExecutor } from './portal-auth-database-types.ts';
import { user } from './portal-auth-tables.ts';

const lookupUnavailable = (cause: unknown): CommercePortalAuthAccountCreationUnavailable =>
  Object.defineProperty(
    new CommercePortalAuthAccountCreationUnavailable({
      reason: 'The Commerce portal account directory could not be read',
    }),
    'cause',
    { configurable: true, value: cause },
  );

/**
 * Owner-local existence probes over the provider's own `user` table. Every query selects a single
 * constant column: no password, token, name, or user record is ever projected across this port, so
 * a caller cannot turn a duplicate guard into account enumeration.
 *
 * Both predicates compare the normalized address. The stored column already holds the normalized
 * form — every writer here (`normalizeCommercePortalAuthEmail` in the recovery store, the intent
 * and rate-limit keys) normalizes first — so comparing a caller's raw casing would let
 * `Ada@example.test` miss the row `ada@example.test`, and the duplicate guard would wave a second
 * account through for an address that already has one.
 */
const makeCommercePortalAuthAccountLookup = (
  database: CommercePortalAuthDatabaseExecutor,
): CommercePortalAuthAccountLookup => {
  const existsWhere = (condition: SQL | undefined) =>
    database
      .select({ present: user.id })
      .from(user)
      .where(condition)
      .limit(1)
      .pipe(
        Effect.mapError(lookupUnavailable),
        Effect.map((rows) => rows.length > 0),
      );

  return {
    existsByEmail: ({ email }) => existsWhere(eq(user.email, normalizeCommercePortalAuthEmail(email))),
    existsByProviderSubject: ({ email, providerSubjectId }) =>
      existsWhere(
        email === undefined
          ? eq(user.id, providerSubjectId)
          : and(eq(user.id, providerSubjectId), eq(user.email, normalizeCommercePortalAuthEmail(email))),
      ),
  };
};

export const CommercePortalAuthAccountLookupLive = Layer.effect(
  CommercePortalAuthAccountLookupService,
  Effect.gen(function* makeCommercePortalAuthAccountLookupLayer() {
    const database = yield* CommercePortalAuthDatabase;
    return makeCommercePortalAuthAccountLookup(database.executor);
  }),
);
