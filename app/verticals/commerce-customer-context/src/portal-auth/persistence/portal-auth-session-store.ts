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
import type {
  CommercePortalAuthSessionAudited,
  CommercePortalAuthSessionStore,
} from '../../../api/portal-auth/session/store-service.ts';
import type { CommercePortalAuthAuditEvent } from '../audit/audit-contracts.ts';
import { commercePortalAuthAuditRow } from '../audit/audit-mapping.ts';
import { portalAuthAuditEvent } from '../audit/audit-tables.ts';
import { CommercePortalAuthAuditUnavailable, commercePortalAuthAuditUnavailable } from '../audit/audit-unavailable.ts';
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

/**
 * A refused audit insert and a refused mutation are the same outage to a caller — PostgreSQL rolls
 * the one transaction back either way — but the operation name keeps them apart in a log.
 */
const mutationFailure = (operation: string, cause: unknown): CommercePortalAuthSessionUnavailable =>
  Schema.is(CommercePortalAuthAuditUnavailable)(cause) ? unavailable(`${operation}-audit`, cause) : unavailable(operation, cause);

/** The handle the executor hands a transaction body; it writes the same tables the executor does. */
type CommercePortalAuthDatabaseTransaction = Parameters<
  Parameters<CommercePortalAuthDatabaseExecutor['transaction']>[0]
>[0];

/**
 * The audit row for a mutation that actually changed state, written on that mutation's own
 * transaction handle. A refused insert fails the transaction, so the state change rolls back with
 * it and the operation reports the outage instead of committing without evidence. A transaction
 * that changed nothing passes `undefined`: that outcome is a decision, not a state change, and the
 * caller records it through the lenient recorder.
 */
const writeAuditRow = (
  transaction: CommercePortalAuthDatabaseTransaction,
  audit: CommercePortalAuthAuditEvent | undefined,
): Effect.Effect<void, CommercePortalAuthAuditUnavailable> =>
  audit === undefined
    ? Effect.void
    : transaction
        .insert(portalAuthAuditEvent)
        .values(commercePortalAuthAuditRow(audit))
        .pipe(Effect.asVoid, Effect.mapError(commercePortalAuthAuditUnavailable));

const sessionProjection = {
  authenticatedAt: session.authenticatedAt,
  banExpiresAt: user.banExpires,
  banned: user.banned,
  createdAt: session.createdAt,
  emailVerified: user.emailVerified,
  expiresAt: session.expiresAt,
  providerSubjectId: user.id,
  sessionId: session.id,
  token: session.token,
  updatedAt: session.updatedAt,
} as const;

const sessionActivityProjection = {
  createdAt: session.createdAt,
  expiresAt: session.expiresAt,
} as const;

interface SessionProjection {
  readonly authenticatedAt: Date | null;
  readonly banExpiresAt: Date | null;
  readonly banned: boolean | null;
  readonly createdAt: Date;
  readonly emailVerified: boolean;
  readonly expiresAt: Date;
  readonly providerSubjectId: string;
  readonly sessionId: string;
  readonly token: string;
  readonly updatedAt: Date;
}

const projectRecord = (row: SessionProjection): CommercePortalAuthSessionRecord => ({
  authenticatedAt: row.authenticatedAt,
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

interface TouchInput {
  readonly expectedUpdatedAt: Date;
  readonly expiresAt: Date;
  readonly now: Date;
  readonly sessionId: string;
}

interface RevokeInput {
  readonly providerSubjectId?: string;
  readonly sessionId: string;
}

interface RotateInput {
  readonly authenticatedAt?: Date;
  readonly expectedProviderSubjectId?: string;
  readonly expiresAt: Date;
  readonly now: Date;
  readonly sessionId: string;
}

/**
 * Native PostgreSQL session store used by the Better Auth realm. All mutations are scoped to the
 * Commerce provider tables; no Core binding or Tenant row is touched by these operations.
 *
 * Every mutating method runs in one transaction, and the audited variants write the caller's audit
 * row inside it. That is the containment boundary for #340 evidence: a revocation, an account
 * disable, an identifier rotation or an inactivity renewal either commits together with its row or
 * does not commit at all.
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

  const touchIn = (
    audit: CommercePortalAuthAuditEvent | undefined,
    input: TouchInput,
  ): Effect.Effect<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable> =>
    database
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
          yield* writeAuditRow(transaction, audit);
          return Option.some(projectRecord({ ...currentRow, expiresAt: input.expiresAt, updatedAt: input.now }));
        }),
      )
      .pipe(Effect.mapError((cause) => mutationFailure('session-touch', cause)));

  const touch = Effect.fn('CommercePortalAuthSessionStore.touch')(function* touch(
    input: TouchInput,
  ): Effect.fn.Return<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable> {
    return yield* touchIn(undefined, input);
  });

  const touchWithAudit = Effect.fn('CommercePortalAuthSessionStore.touchWithAudit')(function* touchWithAudit(
    input: CommercePortalAuthSessionAudited & TouchInput,
  ): Effect.fn.Return<Option.Option<CommercePortalAuthSessionRecord>, CommercePortalAuthSessionUnavailable> {
    const { audit, ...touchInput } = input;
    return yield* touchIn(audit, touchInput);
  });

  const revokeIn = (
    audit: CommercePortalAuthAuditEvent | undefined,
    input: RevokeInput,
  ): Effect.Effect<boolean, CommercePortalAuthSessionUnavailable> =>
    database
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
          if (deleted.length === 0) {
            return false;
          }
          yield* writeAuditRow(transaction, audit);
          return true;
        }),
      )
      .pipe(Effect.mapError((cause) => mutationFailure('session-revoke', cause)));

  const revoke = Effect.fn('CommercePortalAuthSessionStore.revoke')(function* revoke(
    input: RevokeInput,
  ): Effect.fn.Return<boolean, CommercePortalAuthSessionUnavailable> {
    return yield* revokeIn(undefined, input);
  });

  const revokeWithAudit = Effect.fn('CommercePortalAuthSessionStore.revokeWithAudit')(function* revokeWithAudit(
    input: CommercePortalAuthSessionAudited & RevokeInput,
  ): Effect.fn.Return<boolean, CommercePortalAuthSessionUnavailable> {
    const { audit, ...revokeInput } = input;
    return yield* revokeIn(audit, revokeInput);
  });

  const revokeAllWithAudit = Effect.fn('CommercePortalAuthSessionStore.revokeAllWithAudit')(
    function* revokeAllWithAudit(
      input: CommercePortalAuthSessionAudited & { readonly providerSubjectId: string },
    ): Effect.fn.Return<number, CommercePortalAuthSessionUnavailable> {
      return yield* database
        .transaction(
          Effect.fn('CommercePortalAuthSessionStore.revokeAll.transaction')(function* revokeAllTransaction(
            transaction,
          ) {
            const locked = yield* transaction
              .update(user)
              .set({ updatedAt: sql`${user.updatedAt}` })
              .where(eq(user.id, input.providerSubjectId))
              .returning({ id: user.id });
            if (locked.length === 0) {
              return 0;
            }

            const deleted = yield* transaction
              .delete(session)
              .where(eq(session.userId, input.providerSubjectId))
              .returning({ id: session.id });
            if (deleted.length === 0) {
              return 0;
            }
            yield* writeAuditRow(transaction, input.audit);
            return deleted.length;
          }),
        )
        .pipe(Effect.mapError((cause) => mutationFailure('session-revoke-all', cause)));
    },
  );

  const disableAccountWithAudit = Effect.fn('CommercePortalAuthSessionStore.disableAccountWithAudit')(
    function* disableAccountWithAudit(
      input: CommercePortalAuthSessionAudited & { readonly providerSubjectId: string },
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
                .where(eq(user.id, input.providerSubjectId))
                .returning({ id: user.id });
              if (updated.length === 0) {
                return false;
              }
              // Account status, session cleanup and the audit row commit together while holding the
              // subject row lock.
              yield* transaction.delete(session).where(eq(session.userId, input.providerSubjectId));
              yield* writeAuditRow(transaction, input.audit);
              return true;
            },
          ),
        )
        .pipe(Effect.mapError((cause) => mutationFailure('account-disable', cause)));
    },
  );

  const rotateWithAudit = Effect.fn('CommercePortalAuthSessionStore.rotateWithAudit')(function* rotateWithAudit(
    input: CommercePortalAuthSessionAudited & RotateInput,
  ): Effect.fn.Return<
    Option.Option<CommercePortalAuthSessionRecord>,
    CommercePortalAuthSessionUnavailable | CommercePortalAuthSessionRefreshConflict
  > {
    return yield* database
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
            // `createdAt` carries the absolute session lifetime, so rotation preserves it. The
            // fresh-authentication stamp travels separately: supplied when this rotation itself
            // re-authenticated the customer, carried forward from the source row otherwise.
            authenticatedAt: input.authenticatedAt ?? current.authenticatedAt,
            createdAt: current.createdAt,
            expiresAt: input.expiresAt,
            id: newSessionId,
            ipAddress: null,
            token: newToken,
            updatedAt: input.now,
            userAgent: null,
            userId: current.providerSubjectId,
          });
          const deleted = yield* transaction
            .delete(session)
            .where(and(eq(session.id, input.sessionId), eq(session.userId, current.providerSubjectId)))
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
          if (row === undefined) {
            return Option.none();
          }
          yield* writeAuditRow(transaction, input.audit);
          return Option.some(projectRecord(row));
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(CommercePortalAuthSessionRefreshConflict)(cause)
            ? cause
            : mutationFailure('session-rotation', cause),
        ),
      );
  });

  return Object.freeze({
    countActive,
    disableAccountWithAudit,
    findById,
    findByToken,
    revoke,
    revokeAllWithAudit,
    revokeWithAudit,
    rotateWithAudit,
    touch,
    touchWithAudit,
  });
};

/** The provider database stays a visible requirement; the composition root supplies it once. */
export const CommercePortalAuthSessionStoreLive = Layer.effect(
  CommercePortalAuthSessionStoreService,
  Effect.gen(function* makeStoreLive() {
    const database = yield* CommercePortalAuthDatabase;
    return makeCommercePortalAuthSessionStore(database.executor);
  }),
);
