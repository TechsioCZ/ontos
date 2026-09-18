import { randomBytes } from 'node:crypto';

import { and, eq, gt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';

import {
  CommercePortalAuthSessionRefreshConflict,
  CommercePortalAuthSessionUnavailable,
} from '../../../api/portal-auth/session/errors.ts';
import type { CommercePortalAuthSessionRecord } from '../../../api/portal-auth/session/contracts.ts';
import { CommercePortalAuthSessionStoreService } from '../../../api/portal-auth/session/store-service.ts';
import type { CommercePortalAuthSessionStore } from '../../../api/portal-auth/session/store-service.ts';
import { CommercePortalAuthDatabase } from './portal-auth-database.ts';
import type { CommercePortalAuthDatabaseExecutor } from './portal-auth-database-types.ts';
import { session, user } from './portal-auth-tables.ts';

const withCause = <TError extends object>(error: TError, cause: unknown): TError =>
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });

const unavailable = (operation: string, cause: unknown): CommercePortalAuthSessionUnavailable =>
  withCause(
    new CommercePortalAuthSessionUnavailable({
      operation,
      reason: `Commerce portal authentication ${operation} could not complete`,
    }),
    cause,
  );

const sessionProjection = {
  banExpiresAt: user.banExpires,
  banned: user.banned,
  createdAt: session.createdAt,
  emailVerified: user.emailVerified,
  expiresAt: session.expiresAt,
  providerSubjectId: user.id,
  sessionId: session.id,
  token: session.token,
  updatedAt: session.updatedAt,
  userId: session.userId,
} as const;

const sessionActivityProjection = {
  createdAt: session.createdAt,
  expiresAt: session.expiresAt,
} as const;

interface SessionProjection {
  readonly banExpiresAt: Date | null;
  readonly banned: boolean | null;
  readonly createdAt: Date;
  readonly emailVerified: boolean;
  readonly expiresAt: Date;
  readonly providerSubjectId: string;
  readonly sessionId: string;
  readonly token: string;
  readonly updatedAt: Date;
  readonly userId: string;
}

const projectRecord = (row: SessionProjection): CommercePortalAuthSessionRecord => ({
  banExpiresAt: row.banExpiresAt,
  banned: row.banned ?? false,
  createdAt: row.createdAt,
  emailVerified: row.emailVerified,
  expiresAt: row.expiresAt,
  id: row.sessionId,
  providerSubjectId: row.providerSubjectId,
  token: row.token,
  updatedAt: row.updatedAt,
});

const findBy = (
  database: CommercePortalAuthDatabaseExecutor,
  where: SQL,
): Effect.Effect<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable> =>
  // The exact Drizzle query is kept in this owner-local adapter. It selects token only to resolve
  // a just-created Better Auth response and never exposes it beyond this module.
  database
    .select(sessionProjection)
    .from(session)
    .innerJoin(user, eq(session.userId, user.id))
    .where(where)
    .limit(1)
    .pipe(
      Effect.map((rows) => {
        const [row] = rows;
        return row === undefined ? Option.none() : Option.some(projectRecord(row));
      }),
      Effect.mapError((cause) => unavailable('session-read', cause)),
    );

const epochMillis = (value: Date): number => {
  const date = DateTime.make(value);
  return Option.isSome(date) ? DateTime.toEpochMillis(date.value) : Number.NaN;
};

const isLiveForCount = (
  record: Pick<CommercePortalAuthSessionRecord, 'createdAt' | 'expiresAt'>,
  now: number,
  absoluteLifetimeSeconds: number,
): boolean => {
  const createdAt = epochMillis(record.createdAt);
  const expiresAt = epochMillis(record.expiresAt);
  return (
    Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    createdAt <= now &&
    DateTime.toEpochMillis(
      DateTime.add(DateTime.makeUnsafe(record.createdAt), {
        seconds: absoluteLifetimeSeconds,
      }),
    ) > now &&
    expiresAt > now
  );
};

const newOpaqueId = (bytes: number): string => randomBytes(bytes).toString('base64url');

/**
 * Native PostgreSQL session store used by the Better Auth realm. All mutations are scoped to the
 * Commerce provider tables; no Core binding or Tenant row is touched by these operations.
 */
export const makeCommercePortalAuthSessionStore = (
  database: CommercePortalAuthDatabaseExecutor,
): CommercePortalAuthSessionStore => {
  const findById = Effect.fn('CommercePortalAuthSessionStore.findById')(function* findById(
    sessionId: string,
  ): Effect.fn.Return<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable> {
    return yield* findBy(database, eq(session.id, sessionId));
  });

  const findByToken = Effect.fn('CommercePortalAuthSessionStore.findByToken')(function* findByToken(
    token: string,
  ): Effect.fn.Return<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable> {
    return yield* findBy(database, eq(session.token, token));
  });

  const countActive = Effect.fn('CommercePortalAuthSessionStore.countActive')(function* countActive(input: {
    readonly absoluteLifetimeSeconds: number;
    readonly now: Date;
    readonly providerSubjectId: string;
  }): Effect.fn.Return<number, CommercePortalAuthSessionUnavailable> {
    const rows = yield* database
      .select(sessionActivityProjection)
      .from(session)
      .innerJoin(user, eq(session.userId, user.id))
      .where(eq(user.id, input.providerSubjectId))
      .pipe(Effect.mapError((cause) => unavailable('session-count', cause)));
    return rows.filter((row) => isLiveForCount(row, epochMillis(input.now), input.absoluteLifetimeSeconds)).length;
  });

  const touch = Effect.fn('CommercePortalAuthSessionStore.touch')(function* touch(input: {
    readonly expectedUpdatedAt: Date;
    readonly expiresAt: Date;
    readonly now: Date;
    readonly sessionId: string;
  }): Effect.fn.Return<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable> {
    return yield* database
      .transaction(
        Effect.fn('CommercePortalAuthSessionStore.touch.transaction')(function* touchTransaction(transaction) {
          const initial = yield* transaction
            .select({ providerSubjectId: session.userId })
            .from(session)
            .where(eq(session.id, input.sessionId))
            .limit(1);
          const [initialRow] = initial;
          if (initialRow === undefined) {
            return Option.none();
          }

          // Every session mutation takes the account row lock. This serializes refresh, rotation,
          // single-session revoke and account-wide revoke under PostgreSQL READ COMMITTED.
          const locked = yield* transaction
            .update(user)
            .set({ updatedAt: sql`${user.updatedAt}` })
            .where(eq(user.id, initialRow.providerSubjectId))
            .returning({ id: user.id });
          if (locked.length === 0) {
            return Option.none();
          }

          const current = yield* transaction
            .select(sessionProjection)
            .from(session)
            .innerJoin(user, eq(session.userId, user.id))
            .where(
              and(
                eq(session.id, input.sessionId),
                eq(session.updatedAt, input.expectedUpdatedAt),
                gt(session.expiresAt, input.now),
              ),
            )
            .limit(1);
          const [currentRow] = current;
          if (currentRow === undefined) {
            return Option.none();
          }

          yield* transaction
            .update(session)
            .set({ expiresAt: input.expiresAt, updatedAt: input.now })
            .where(eq(session.id, input.sessionId));
          return Option.some(projectRecord({ ...currentRow, expiresAt: input.expiresAt, updatedAt: input.now }));
        }),
      )
      .pipe(Effect.mapError((cause) => unavailable('session-touch', cause)));
  });

  const revoke = Effect.fn('CommercePortalAuthSessionStore.revoke')(function* revoke(input: {
    readonly providerSubjectId?: string;
    readonly sessionId: string;
  }): Effect.fn.Return<boolean, CommercePortalAuthSessionUnavailable> {
    return yield* database
      .transaction(
        Effect.fn('CommercePortalAuthSessionStore.revoke.transaction')(function* revokeTransaction(transaction) {
          const current = yield* transaction
            .select({ providerSubjectId: session.userId })
            .from(session)
            .where(eq(session.id, input.sessionId))
            .limit(1);
          const [currentRow] = current;
          if (
            currentRow === undefined ||
            (input.providerSubjectId !== undefined && currentRow.providerSubjectId !== input.providerSubjectId)
          ) {
            return false;
          }

          const locked = yield* transaction
            .update(user)
            .set({ updatedAt: sql`${user.updatedAt}` })
            .where(eq(user.id, currentRow.providerSubjectId))
            .returning({ id: user.id });
          if (locked.length === 0) {
            return false;
          }

          const deleted = yield* transaction
            .delete(session)
            .where(and(eq(session.id, input.sessionId), eq(session.userId, currentRow.providerSubjectId)))
            .returning({ id: session.id });
          return deleted.length > 0;
        }),
      )
      .pipe(Effect.mapError((cause) => unavailable('session-revoke', cause)));
  });

  const revokeAll = Effect.fn('CommercePortalAuthSessionStore.revokeAll')(function* revokeAll(
    providerSubjectId: string,
  ): Effect.fn.Return<number, CommercePortalAuthSessionUnavailable> {
    return yield* database
      .transaction(
        Effect.fn('CommercePortalAuthSessionStore.revokeAll.transaction')(function* revokeAllTransaction(transaction) {
          const locked = yield* transaction
            .update(user)
            .set({ updatedAt: sql`${user.updatedAt}` })
            .where(eq(user.id, providerSubjectId))
            .returning({ id: user.id });
          if (locked.length === 0) {
            return 0;
          }

          const deleted = yield* transaction
            .delete(session)
            .where(eq(session.userId, providerSubjectId))
            .returning({ id: session.id });
          return deleted.length;
        }),
      )
      .pipe(Effect.mapError((cause) => unavailable('session-revoke-all', cause)));
  });

  const disableAccount = Effect.fn('CommercePortalAuthSessionStore.disableAccount')(function* disableAccount(
    providerSubjectId: string,
  ): Effect.fn.Return<boolean, CommercePortalAuthSessionUnavailable> {
    return yield* database
      .transaction(
        Effect.fn('CommercePortalAuthSessionStore.disableAccount.transaction')(
          function* disableAccountTransaction(transaction) {
            const updated = yield* transaction
              .update(user)
              .set({
                banExpires: null,
                banned: true,
                banReason: 'commerce-account-disabled',
                updatedAt: DateTime.toDate(DateTime.nowUnsafe()),
              })
              .where(eq(user.id, providerSubjectId))
              .returning({ id: user.id });
            if (updated.length === 0) {
              return false;
            }
            // Account status and session cleanup commit together while holding the subject row lock.
            yield* transaction.delete(session).where(eq(session.userId, providerSubjectId));
            return true;
          },
        ),
      )
      .pipe(Effect.mapError((cause) => unavailable('account-disable', cause)));
  });

  const rotate = Effect.fn('CommercePortalAuthSessionStore.rotate')(function* rotate(input: {
    readonly expectedProviderSubjectId?: string;
    readonly expiresAt: Date;
    readonly now: Date;
    readonly sessionId: string;
  }): Effect.fn.Return<
    Option.Option<CommercePortalAuthSessionRecord>,
    CommercePortalAuthSessionUnavailable | CommercePortalAuthSessionRefreshConflict
  > {
    const rotated = yield* database
      .transaction(
        Effect.fn('CommercePortalAuthSessionStore.rotate.transaction')(function* rotateTransaction(transaction) {
          const initial = yield* transaction
            .select({ providerSubjectId: session.userId })
            .from(session)
            .where(eq(session.id, input.sessionId))
            .limit(1);
          const [initialRow] = initial;
          if (
            initialRow === undefined ||
            (input.expectedProviderSubjectId !== undefined &&
              initialRow.providerSubjectId !== input.expectedProviderSubjectId)
          ) {
            return Option.none();
          }

          // Lock the stable provider subject before reading the session again. A concurrent
          // revoke-all therefore either commits first (and rotation sees no source row) or waits
          // for this replacement transaction and deletes the replacement in its own transaction.
          const locked = yield* transaction
            .update(user)
            .set({ updatedAt: sql`${user.updatedAt}` })
            .where(eq(user.id, initialRow.providerSubjectId))
            .returning({ id: user.id });
          if (locked.length === 0) {
            return Option.none();
          }

          const rows = yield* transaction
            .select(sessionProjection)
            .from(session)
            .innerJoin(user, eq(session.userId, user.id))
            .where(
              and(
                eq(session.id, input.sessionId),
                eq(session.userId, initialRow.providerSubjectId),
                input.expectedProviderSubjectId === undefined
                  ? undefined
                  : eq(user.id, input.expectedProviderSubjectId),
              ),
            )
            .limit(1);
          const [current] = rows;
          if (current === undefined) {
            return Option.none();
          }

          const newSessionId = newOpaqueId(18);
          const newToken = newOpaqueId(32);
          yield* transaction.insert(session).values({
            createdAt: current.createdAt,
            expiresAt: input.expiresAt,
            id: newSessionId,
            ipAddress: null,
            token: newToken,
            updatedAt: input.now,
            userAgent: null,
            userId: current.userId,
          });
          const deleted = yield* transaction
            .delete(session)
            .where(and(eq(session.id, input.sessionId), eq(session.userId, current.userId)))
            .returning({ id: session.id });
          if (deleted.length === 0) {
            return yield* new CommercePortalAuthSessionRefreshConflict({
              reason: 'Commerce portal session changed while its identifier was rotating',
            });
          }
          const replacement = yield* transaction
            .select(sessionProjection)
            .from(session)
            .innerJoin(user, eq(session.userId, user.id))
            .where(eq(session.id, newSessionId))
            .limit(1);
          const [row] = replacement;
          return row === undefined ? Option.none() : Option.some(projectRecord(row));
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(CommercePortalAuthSessionRefreshConflict)(cause) ? cause : unavailable('session-rotation', cause),
        ),
      );
    return rotated;
  });

  return Object.freeze({ countActive, disableAccount, findById, findByToken, revoke, revokeAll, rotate, touch });
};

/** The provider database stays a visible requirement; the composition root supplies it once. */
export const CommercePortalAuthSessionStoreLive = Layer.effect(
  CommercePortalAuthSessionStoreService,
  Effect.gen(function* makeStoreLive() {
    const database = yield* CommercePortalAuthDatabase;
    return makeCommercePortalAuthSessionStore(database.executor);
  }),
);
