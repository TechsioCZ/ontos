import { and, eq, gt, inArray, like, lt, sql } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';

import { CommercePortalAuthProviderSubjectIdSchema } from '../../../api/portal-auth/provider/recovery/contracts.ts';
import type {
  CommercePortalAuthEmailVerificationTokenRegistration,
  CommercePortalAuthRecoveryReconciliationConflictClass,
} from '../../../api/portal-auth/provider/recovery/contracts.ts';
import { withCause } from '../../../api/portal-auth/problems-support.ts';
import { normalizeCommercePortalAuthEmail } from '../email-normalization.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../../../api/portal-auth/rate-limit-service.ts';
import { CommercePortalAuthRecoveryUnavailable } from '../../../api/portal-auth/provider/recovery/unavailable.ts';
import { CommercePortalAuthRecoveryStoreService } from '../../../api/portal-auth/provider/recovery/store-service.ts';
import type {
  CommercePortalAuthRecoveryLedgerBinding,
  CommercePortalAuthRecoveryResetClaim,
  CommercePortalAuthRecoveryStore,
} from '../../../api/portal-auth/provider/recovery/store-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../../api/portal-auth/provider/config.ts';
import type { CommercePortalAuthAuditEvent } from '../audit/audit-contracts.ts';
import type { CommercePortalAuthDatabaseTransaction } from '../audit/audit-transaction.ts';
import { writeCommercePortalAuthAuditRow } from '../audit/audit-transaction.ts';
import { CommercePortalAuthAuditUnavailable } from '../audit/audit-unavailable.ts';
import { CommercePortalAuthDatabase } from './portal-auth-database.ts';
import type { CommercePortalAuthDatabaseExecutor } from './portal-auth-database-types.ts';
import { rateLimit, recoveryReconciliation, recoveryResetLedger, user, verification } from './portal-auth-tables.ts';

const EMAIL_VERIFICATION_IDENTIFIER_PREFIX = 'commerce-email-verification:';
const EMAIL_VERIFICATION_RESERVATION_IDENTIFIER_PREFIX = 'commerce-email-verification-pending:';
const RESET_LEDGER_STATE_PENDING = 'pending';
const RESET_LEDGER_STATE_EXPIRED = 'expired';
const RESET_LEDGER_STATE_CONSUMED = 'consumed';
/** Claimed for one provider dispatch whose outcome this realm has not learned. */
const RESET_LEDGER_STATE_DISPATCHED = 'dispatched';
const RESET_LEDGER_SWEEP_OPERATION = 'recovery-reset-ledger-sweep';
/** A sweep touches at most this many stale rows per call: bounded work, never a table scan. */
const RESET_LEDGER_SWEEP_BATCH_SIZE = 100;
/** Same operation label as `recovery/reconciliation.ts`, so sweep and service rows dedupe together. */
const RESET_LEDGER_RECONCILIATION_OPERATION = 'reset-password';
const RESET_LEDGER_SWEEP_ROW_OPERATION = 'recovery-reset-ledger-sweep-row';
/**
 * How long a claimed row may keep the binding a lost dispatch left behind. A claim older than the
 * reset token's whole lifetime belongs to a submission nobody is coming back for.
 */
const RESET_LEDGER_DISPATCH_WINDOW_SECONDS = COMMERCE_PORTAL_AUTH_POLICY.password.resetTokenExpiresInSeconds;
const verificationLedgerEmail = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(3), Schema.isMaxLength(320));
const VerificationLedgerRecordSchema = Schema.Struct({
  email: verificationLedgerEmail,
  providerSubjectId: CommercePortalAuthProviderSubjectIdSchema,
});
type VerificationLedgerRecord = typeof VerificationLedgerRecordSchema.Type;

const unavailable = (operation: string, cause: unknown): CommercePortalAuthRecoveryUnavailable =>
  withCause(
    new CommercePortalAuthRecoveryUnavailable({
      operation,
      reason: `Commerce portal authentication ${operation} could not complete`,
    }),
    cause,
  );

/**
 * A refused audit insert and a refused ledger write are the same outage to a caller — PostgreSQL
 * rolls the one transaction back either way — but the operation name keeps them apart in a log.
 */
const mutationFailure = (operation: string, cause: unknown): CommercePortalAuthRecoveryUnavailable =>
  Schema.is(CommercePortalAuthAuditUnavailable)(cause)
    ? unavailable(`${operation}-audit`, cause)
    : unavailable(operation, cause);

const sweepAgedDispatchedRowUnavailable = (cause: unknown): CommercePortalAuthRecoveryUnavailable =>
  unavailable(RESET_LEDGER_SWEEP_ROW_OPERATION, cause);

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const encodeVerificationLedgerRecord = (input: {
  readonly email: string;
  readonly providerSubjectId: string;
}): string => {
  const email = normalizeCommercePortalAuthEmail(input.email);
  return `${input.providerSubjectId.length}:${input.providerSubjectId}${email.length}:${email}`;
};

const readLengthPrefix = (
  value: string,
  start: number,
): Option.Option<{ readonly length: number; readonly valueStart: number }> => {
  const separator = value.indexOf(':', start);
  if (separator === -1) {
    return Option.none();
  }
  const length = Number(value.slice(start, separator));
  if (!Number.isSafeInteger(length) || length < 0) {
    return Option.none();
  }
  return Option.some({ length, valueStart: separator + 1 });
};

const decodeVerificationLedgerRecord = (value: string): Option.Option<VerificationLedgerRecord> => {
  const subjectPrefix = readLengthPrefix(value, 0);
  if (Option.isNone(subjectPrefix)) {
    return Option.none();
  }
  const subjectEnd = subjectPrefix.value.valueStart + subjectPrefix.value.length;
  if (subjectEnd > value.length) {
    return Option.none();
  }
  const emailPrefix = readLengthPrefix(value, subjectEnd);
  if (Option.isNone(emailPrefix)) {
    return Option.none();
  }
  const emailEnd = emailPrefix.value.valueStart + emailPrefix.value.length;
  if (emailEnd !== value.length) {
    return Option.none();
  }
  const decoded = Schema.decodeOption(VerificationLedgerRecordSchema)({
    email: value.slice(emailPrefix.value.valueStart, emailEnd),
    providerSubjectId: value.slice(subjectPrefix.value.valueStart, subjectEnd),
  });
  return Option.isSome(decoded) && decoded.value.email === normalizeCommercePortalAuthEmail(decoded.value.email)
    ? decoded
    : Option.none();
};

const emailVerificationIdentifier = (digest: string): string => `${EMAIL_VERIFICATION_IDENTIFIER_PREFIX}${digest}`;

const emailVerificationReservationIdentifier = (digest: string): string =>
  `${EMAIL_VERIFICATION_RESERVATION_IDENTIFIER_PREFIX}${digest}`;

const digestText = (crypto: Crypto.Crypto, value: string) =>
  crypto.digest('SHA-256', new TextEncoder().encode(value)).pipe(Effect.map(bytesToHex));

const digestToken = (crypto: Crypto.Crypto, token: Redacted.Redacted) =>
  crypto.digest('SHA-256', new TextEncoder().encode(Redacted.value(token))).pipe(Effect.map(bytesToHex));

const epochMillis = (value: Date): number => {
  const date = DateTime.make(value);
  return Option.isSome(date) ? DateTime.toEpochMillis(date.value) : Number.NaN;
};

/** Every writer of `recovery_reconciliation` goes through here so they all dedupe on the same index. */
const insertRecoveryReconciliationRow = (
  executor: CommercePortalAuthDatabaseExecutor | CommercePortalAuthDatabaseTransaction,
  input: {
    readonly conflictClass: CommercePortalAuthRecoveryReconciliationConflictClass;
    readonly createdAt: Date;
    readonly currentProviderSubjectId: Option.Option<string>;
    readonly email: string;
    readonly id: string;
    readonly operation: string;
    readonly providerSubjectId: string;
  },
) =>
  executor
    .insert(recoveryReconciliation)
    .values({
      conflictClass: input.conflictClass,
      createdAt: input.createdAt,
      currentProviderSubjectId: Option.getOrNull(input.currentProviderSubjectId),
      email: normalizeCommercePortalAuthEmail(input.email),
      id: input.id,
      operation: input.operation,
      providerSubjectId: input.providerSubjectId,
    })
    // Target the dedupe unique index, not the primary key: `id` is a fresh UUID on every call and
    // never conflicts, so targeting it would let a repeated detection raise an unhandled
    // unique-violation on `commerce_auth_recovery_reconciliation_dedupe_uk` instead of silently
    // no-op'ing.
    .onConflictDoNothing({
      target: [
        recoveryReconciliation.operation,
        recoveryReconciliation.providerSubjectId,
        recoveryReconciliation.email,
        recoveryReconciliation.conflictClass,
      ],
    });

const MILLISECONDS_PER_SECOND = 1000;
const RATE_LIMIT_SWEEP_OPERATION = 'recovery-rate-limit-sweep';
/** A row older than the longest configured rule is spent for every rule, so the sweep is safe. */
const RATE_LIMIT_RETENTION_MILLISECONDS =
  Math.max(...Object.values(COMMERCE_PORTAL_AUTH_POLICY.rateLimit).map(({ windowSeconds }) => windowSeconds)) *
  MILLISECONDS_PER_SECOND;

/**
 * The verification table is already provider-owned Better Auth state. The recovery ledger stores
 * only a token digest and the immutable provider user id plus normalized issued email; atomic
 * consume and email verification happen in one database transaction, so a deleted/recreated user
 * or changed email can never inherit the token.
 */
export const makeCommercePortalAuthRecoveryStore = Effect.fn('CommercePortalAuthRecoveryStore.make')(
  function* makeCommercePortalAuthRecoveryStoreEffect(
    database: CommercePortalAuthDatabaseExecutor,
  ): Effect.fn.Return<CommercePortalAuthRecoveryStore, never, Crypto.Crypto> {
    const crypto = yield* Crypto.Crypto;

    const registerEmailVerificationToken = Effect.fn('CommercePortalAuthRecoveryStore.registerEmailVerificationToken')(
      function* registerEmailVerificationTokenEffect(
        input: CommercePortalAuthEmailVerificationTokenRegistration & { readonly expiresAt: Date },
      ): Effect.fn.Return<boolean, CommercePortalAuthRecoveryUnavailable> {
        const now = yield* DateTime.nowAsDate;
        const digest = yield* digestToken(crypto, input.token).pipe(
          Effect.mapError((cause) => unavailable('verification-token-hash', cause)),
        );
        const verificationId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => unavailable('verification-token-id', cause)),
        );
        const identifier = emailVerificationIdentifier(digest);
        const reservationDigest = yield* digestText(crypto, normalizeCommercePortalAuthEmail(input.email)).pipe(
          Effect.mapError((cause) => unavailable('verification-reservation-hash', cause)),
        );
        const reservationIdentifier = emailVerificationReservationIdentifier(reservationDigest);
        return yield* database
          .transaction(
            Effect.fn('CommercePortalAuthRecoveryStore.registerEmailVerificationToken.transaction')(
              function* registerTransaction(transaction) {
                const reservations = yield* transaction
                  .select({ expiresAt: verification.expiresAt, providerSubjectId: verification.value })
                  .from(verification)
                  .where(eq(verification.identifier, reservationIdentifier))
                  .limit(1)
                  .for('update');
                const [reservation] = reservations;
                if (reservation !== undefined) {
                  const reservationExpiry = epochMillis(reservation.expiresAt);
                  const nowMillis = epochMillis(now);
                  if (
                    !Number.isFinite(reservationExpiry) ||
                    !Number.isFinite(nowMillis) ||
                    reservationExpiry <= nowMillis ||
                    reservation.providerSubjectId !== input.providerSubjectId
                  ) {
                    if (reservationExpiry <= nowMillis || !Number.isFinite(reservationExpiry)) {
                      yield* transaction.delete(verification).where(eq(verification.identifier, reservationIdentifier));
                    }
                    return false;
                  }
                  yield* transaction.delete(verification).where(eq(verification.identifier, reservationIdentifier));
                }
                // Better Auth invokes this callback inside its sign-up transaction. The exact committed
                // subject/email binding is therefore validated by consume's atomic user update.
                const existingTokens = yield* transaction
                  .select({ id: verification.id, value: verification.value })
                  .from(verification)
                  .where(like(verification.identifier, `${EMAIL_VERIFICATION_IDENTIFIER_PREFIX}%`));
                const existingTokenIds = existingTokens.flatMap((existingToken) => {
                  const existingRecord = decodeVerificationLedgerRecord(existingToken.value);
                  return Option.isSome(existingRecord) &&
                    existingRecord.value.providerSubjectId === input.providerSubjectId
                    ? [existingToken.id]
                    : [];
                });
                if (existingTokenIds.length > 0) {
                  yield* transaction.delete(verification).where(inArray(verification.id, existingTokenIds));
                }
                yield* transaction.insert(verification).values({
                  createdAt: now,
                  expiresAt: input.expiresAt,
                  id: verificationId,
                  identifier,
                  updatedAt: now,
                  value: encodeVerificationLedgerRecord(input),
                });
                return true;
              },
            ),
          )
          .pipe(Effect.mapError((cause) => unavailable('verification-token-register', cause)));
      },
    );

    const reserveEmailVerificationSubject = Effect.fn(
      'CommercePortalAuthRecoveryStore.reserveEmailVerificationSubject',
    )(function* reserveEmailVerificationSubjectEffect(input: {
      readonly email: string;
      readonly providerSubjectId: string;
    }): Effect.fn.Return<boolean, CommercePortalAuthRecoveryUnavailable> {
      const now = yield* DateTime.nowAsDate;
      const emailDigest = yield* digestText(crypto, normalizeCommercePortalAuthEmail(input.email)).pipe(
        Effect.mapError((cause) => unavailable('verification-reservation-hash', cause)),
      );
      const identifier = emailVerificationReservationIdentifier(emailDigest);
      const reservationId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => unavailable('verification-reservation-id', cause)),
      );
      const expiresAt = DateTime.toDate(
        DateTime.add(DateTime.makeUnsafe(now), {
          seconds: COMMERCE_PORTAL_AUTH_POLICY.emailVerification.expiresInSeconds,
        }),
      );
      return yield* database
        .transaction(
          Effect.fn('CommercePortalAuthRecoveryStore.reserveEmailVerificationSubject.transaction')(
            function* reserveTransaction(transaction) {
              yield* transaction.delete(verification).where(eq(verification.identifier, identifier));
              const subjects = yield* transaction
                .select({ id: user.id })
                .from(user)
                .where(
                  and(
                    eq(user.id, input.providerSubjectId),
                    eq(user.email, normalizeCommercePortalAuthEmail(input.email)),
                    eq(user.emailVerified, false),
                  ),
                )
                .limit(1)
                .for('update');
              if (subjects.length === 0) {
                return false;
              }
              yield* transaction.insert(verification).values({
                createdAt: now,
                expiresAt,
                id: reservationId,
                identifier,
                updatedAt: now,
                value: input.providerSubjectId,
              });
              return true;
            },
          ),
        )
        .pipe(Effect.mapError((cause) => unavailable('verification-reservation', cause)));
    });

    /**
     * Consuming the token and writing the verification's completion audit row are one transaction:
     * consuming it *is* what flips `user.emailVerified`, so a flip that commits without its
     * completion row would leave a verified address unevidenced, and a completion row over a token
     * that was never actually spent would be evidence for a verification that never happened. A
     * refused write rolls back the flip along with it, so the token and the account are left exactly
     * as they were — `Option.none` covers both "no row matched" and "the audit row could not be
     * written", and either way nothing changed.
     */
    const consumeEmailVerificationWithAudit = Effect.fn(
      'CommercePortalAuthRecoveryStore.consumeEmailVerificationWithAudit',
    )(function* consumeEmailVerificationWithAuditEffect(input: {
      readonly audit: CommercePortalAuthAuditEvent;
      readonly now: Date;
      readonly token: Redacted.Redacted;
    }): Effect.fn.Return<Option.Option<string>, CommercePortalAuthRecoveryUnavailable> {
      const digest = yield* digestToken(crypto, input.token).pipe(
        Effect.mapError((cause) => unavailable('verification-token-hash', cause)),
      );
      const identifier = emailVerificationIdentifier(digest);
      return yield* database
        .transaction(
          Effect.fn('CommercePortalAuthRecoveryStore.consumeEmailVerificationWithAudit.transaction')(
            function* consumeTransaction(transaction) {
              const rows = yield* transaction
                .select({ expiresAt: verification.expiresAt, id: verification.id, value: verification.value })
                .from(verification)
                .where(eq(verification.identifier, identifier))
                .for('update');
              // A provider token is deterministic in the realm secret and the address, so a
              // re-registered address can leave two ledger rows under one identifier bound to two
              // different subjects. Postgres defines no order across them, so admitting either one
              // would verify an arbitrary subject. Both rows are spent here and neither is
              // admitted: an ambiguous binding is refused, never guessed.
              if (rows.length > 1) {
                yield* transaction.delete(verification).where(eq(verification.identifier, identifier));
                return Option.none<string>();
              }
              const [row] = rows;
              if (
                row === undefined ||
                !Number.isFinite(epochMillis(row.expiresAt)) ||
                epochMillis(row.expiresAt) <= epochMillis(input.now)
              ) {
                if (row !== undefined) {
                  yield* transaction.delete(verification).where(eq(verification.id, row.id));
                }
                return Option.none<string>();
              }

              const record = decodeVerificationLedgerRecord(row.value);
              if (Option.isNone(record)) {
                yield* transaction.delete(verification).where(eq(verification.id, row.id));
                return Option.none<string>();
              }

              const updated = yield* transaction
                .update(user)
                .set({ emailVerified: true, updatedAt: input.now })
                .where(
                  and(
                    eq(user.id, record.value.providerSubjectId),
                    eq(user.email, record.value.email),
                    eq(user.emailVerified, false),
                  ),
                )
                .returning({ id: user.id });
              // A missed update (account deleted or rebound since `detect` read it) keeps the ledger
              // row, so the retry's `detect` still finds the stale binding and records the conflict.
              if (updated.length !== 1) {
                return Option.none<string>();
              }
              yield* transaction.delete(verification).where(eq(verification.id, row.id));
              yield* writeCommercePortalAuthAuditRow(transaction, {
                ...input.audit,
                correlationDigest: digest,
                providerSubjectId: record.value.providerSubjectId,
              });
              return Option.some(record.value.providerSubjectId);
            },
          ),
        )
        .pipe(Effect.mapError((cause) => mutationFailure('verification-token-consume', cause)));
    });

    /**
     * Housekeeping only: a row untouched for longer than the longest configured window can never
     * deny a request again. A sweep that fails must not deny the request that already paid for its
     * budget, so its cause is reported and the caller continues.
     */
    const sweepSpentRateLimitBudgets = (nowMillis: number) =>
      database
        .delete(rateLimit)
        .where(lt(rateLimit.lastRequest, nowMillis - RATE_LIMIT_RETENTION_MILLISECONDS))
        .pipe(
          Effect.annotateLogs({ operation: RATE_LIMIT_SWEEP_OPERATION }),
          Effect.ignore({ log: true, message: 'Commerce portal recovery rate-limit sweep failed' }),
        );

    /**
     * One guarded upsert decides the whole step, so concurrent requests — in this process or in
     * another replica — cannot all pass the same stale read. `DO UPDATE … WHERE` is the guard: a
     * spent window matches no row, writes nothing and returns nothing, which is the denial. The
     * decision reproduces the semantics Better Auth's database rate-limit storage applied to these
     * same rows: a window older than the rule restarts at one, an unspent window counts up, and a
     * spent window neither counts nor extends itself.
     */
    const consumeRateLimitBudget = Effect.fn('CommercePortalAuthRecoveryStore.consumeRateLimitBudget')(
      function* consumeRateLimitBudgetEffect(input: {
        readonly key: string;
        readonly rule: CommercePortalAuthRecoveryRateLimitRule;
      }): Effect.fn.Return<boolean, CommercePortalAuthRecoveryUnavailable> {
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        const windowStartMillis = nowMillis - input.rule.windowSeconds * MILLISECONDS_PER_SECOND;
        const granted = yield* database
          .insert(rateLimit)
          .values({ count: 1, key: input.key, lastRequest: nowMillis })
          .onConflictDoUpdate({
            set: {
              count: sql`case when ${rateLimit.lastRequest} <= ${windowStartMillis} then 1 else ${rateLimit.count} + 1 end`,
              lastRequest: nowMillis,
            },
            setWhere: sql`${rateLimit.lastRequest} <= ${windowStartMillis} or ${rateLimit.count} < ${input.rule.max}`,
            target: rateLimit.key,
          })
          .returning({ count: rateLimit.count })
          .pipe(Effect.mapError((cause) => unavailable('recovery-rate-limit', cause)));
        const [spent] = granted;
        if (spent === undefined) {
          return false;
        }
        if (spent.count === 1) {
          // Only an opened or rolled-over window pays for the sweep, the cadence Better Auth used.
          yield* sweepSpentRateLimitBudgets(nowMillis);
        }
        return true;
      },
    );

    /**
     * An aged `dispatched` row is the only evidence of a possibly committed reset, so its
     * `RESET_OUTCOME_INDETERMINATE` conflict row is written before the binding is cleared.
     */
    const sweepAgedDispatchedResetLedgerRow = Effect.fn(
      'CommercePortalAuthRecoveryStore.sweepExpiredResetLedgerRows.row',
    )(function* sweepAgedDispatchedResetLedgerRowEffect(input: {
      readonly now: Date;
      readonly row: {
        readonly email: string | null;
        readonly providerSubjectId: string | null;
        readonly tokenDigest: string;
      };
      readonly transaction: CommercePortalAuthDatabaseTransaction;
    }): Effect.fn.Return<void, CommercePortalAuthRecoveryUnavailable> {
      const { now, row, transaction } = input;
      const expire = () =>
        transaction
          .update(recoveryResetLedger)
          .set({ email: null, providerSubjectId: null, state: RESET_LEDGER_STATE_EXPIRED, updatedAt: now })
          .where(eq(recoveryResetLedger.tokenDigest, row.tokenDigest))
          .pipe(Effect.mapError(sweepAgedDispatchedRowUnavailable));
      if (row.email === null || row.providerSubjectId === null) {
        yield* expire();
        return;
      }
      const email = normalizeCommercePortalAuthEmail(row.email);
      const currentSubjects = yield* transaction
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email))
        .limit(1)
        .pipe(Effect.mapError(sweepAgedDispatchedRowUnavailable));
      const reconciliationId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => unavailable('recovery-reconciliation-id', cause)),
      );
      yield* insertRecoveryReconciliationRow(transaction, {
        conflictClass: 'RESET_OUTCOME_INDETERMINATE',
        createdAt: now,
        currentProviderSubjectId: currentSubjects[0] === undefined ? Option.none() : Option.some(currentSubjects[0].id),
        email,
        id: reconciliationId,
        operation: RESET_LEDGER_RECONCILIATION_OPERATION,
        providerSubjectId: row.providerSubjectId,
      }).pipe(Effect.mapError(sweepAgedDispatchedRowUnavailable));
      yield* expire();
    });

    const sweepAgedDispatchedResetLedgerRowEntry =
      (input: { readonly now: Date; readonly transaction: CommercePortalAuthDatabaseTransaction }) =>
      (row: {
        readonly email: string | null;
        readonly providerSubjectId: string | null;
        readonly tokenDigest: string;
      }) =>
        sweepAgedDispatchedResetLedgerRow({ now: input.now, row, transaction: input.transaction });

    const sweepAgedDispatchedResetLedgerRows = Effect.fn(
      'CommercePortalAuthRecoveryStore.sweepExpiredResetLedgerRows.rows',
    )(function* sweepAgedDispatchedResetLedgerRowsEffect(input: {
      readonly agedDispatched: readonly {
        readonly email: string | null;
        readonly providerSubjectId: string | null;
        readonly tokenDigest: string;
      }[];
      readonly now: Date;
      readonly transaction: CommercePortalAuthDatabaseTransaction;
    }): Effect.fn.Return<void, CommercePortalAuthRecoveryUnavailable> {
      yield* Effect.forEach(
        input.agedDispatched,
        sweepAgedDispatchedResetLedgerRowEntry({ now: input.now, transaction: input.transaction }),
        { concurrency: 1 },
      );
    });

    /**
     * Bounded housekeeping for two ways a row stops being useful but keeps its binding: an expired
     * `pending` row clears with a plain expiry, and an aged `dispatched` row clears through
     * `sweepAgedDispatchedResetLedgerRow`. Touches at most `RESET_LEDGER_SWEEP_BATCH_SIZE` rows per
     * state and never denies the triggering request on failure.
     */
    const sweepExpiredResetLedgerRows = (now: Date) =>
      Effect.gen(function* sweepExpiredResetLedgerRowsEffect() {
        const dispatchedBefore = DateTime.toDate(
          DateTime.add(DateTime.makeUnsafe(now), { seconds: -RESET_LEDGER_DISPATCH_WINDOW_SECONDS }),
        );
        const stalePending = database
          .select({ tokenDigest: recoveryResetLedger.tokenDigest })
          .from(recoveryResetLedger)
          .where(and(eq(recoveryResetLedger.state, RESET_LEDGER_STATE_PENDING), lt(recoveryResetLedger.expiresAt, now)))
          .limit(RESET_LEDGER_SWEEP_BATCH_SIZE);
        yield* database
          .update(recoveryResetLedger)
          .set({ email: null, providerSubjectId: null, state: RESET_LEDGER_STATE_EXPIRED, updatedAt: now })
          .where(inArray(recoveryResetLedger.tokenDigest, stalePending));

        yield* database.transaction(
          Effect.fn('CommercePortalAuthRecoveryStore.sweepExpiredResetLedgerRows.dispatchedTransaction')(
            function* sweepAgedDispatchedTransaction(transaction) {
              const agedDispatched = yield* transaction
                .select({
                  email: recoveryResetLedger.email,
                  providerSubjectId: recoveryResetLedger.providerSubjectId,
                  tokenDigest: recoveryResetLedger.tokenDigest,
                })
                .from(recoveryResetLedger)
                .where(
                  and(
                    eq(recoveryResetLedger.state, RESET_LEDGER_STATE_DISPATCHED),
                    lt(recoveryResetLedger.dispatchedAt, dispatchedBefore),
                  ),
                )
                .limit(RESET_LEDGER_SWEEP_BATCH_SIZE)
                .for('update')
                .pipe(Effect.mapError(sweepAgedDispatchedRowUnavailable));
              yield* sweepAgedDispatchedResetLedgerRows({ agedDispatched, now, transaction });
            },
          ),
        );
      }).pipe(
        Effect.annotateLogs({ operation: RESET_LEDGER_SWEEP_OPERATION }),
        Effect.ignore({ log: true, message: 'Commerce portal recovery reset-ledger sweep failed' }),
      );

    /**
     * Read-only issuance-time evidence: never a reason Better Auth's own reset flow succeeds or
     * fails. One row per live token, keyed by `tokenDigest`: Better Auth keeps every unexpired
     * token it issued acceptable, so a second request for the same address must not overwrite the
     * first token's binding — that token would otherwise reach `resetPassword` with no ledger row
     * and skip reconciliation entirely. Re-registering the *same* token upserts its own row, so a
     * retried issuance stays idempotent, and a terminal row is revived to `pending` in place.
     */
    const registerPasswordResetToken = Effect.fn('CommercePortalAuthRecoveryStore.registerPasswordResetToken')(
      function* registerPasswordResetTokenEffect(input: {
        readonly email: string;
        readonly expiresAt: Date;
        readonly providerSubjectId: string;
        readonly token: Redacted.Redacted;
      }): Effect.fn.Return<boolean, CommercePortalAuthRecoveryUnavailable> {
        const now = yield* DateTime.nowAsDate;
        const email = normalizeCommercePortalAuthEmail(input.email);
        // Independent digests over unrelated inputs (the email vs. the token): safe and worth
        // running concurrently, bounded to the two of them.
        const [identifierDigest, tokenDigest] = yield* Effect.all(
          [
            digestText(crypto, email).pipe(
              Effect.mapError((cause) => unavailable('password-reset-identifier-hash', cause)),
            ),
            digestToken(crypto, input.token).pipe(
              Effect.mapError((cause) => unavailable('password-reset-token-hash', cause)),
            ),
          ],
          { concurrency: 2 },
        );
        yield* sweepExpiredResetLedgerRows(now);
        return yield* database
          .insert(recoveryResetLedger)
          .values({
            createdAt: now,
            email,
            expiresAt: input.expiresAt,
            identifierDigest,
            providerSubjectId: input.providerSubjectId,
            state: RESET_LEDGER_STATE_PENDING,
            tokenDigest,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            set: {
              email,
              expiresAt: input.expiresAt,
              identifierDigest,
              providerSubjectId: input.providerSubjectId,
              state: RESET_LEDGER_STATE_PENDING,
              updatedAt: now,
            },
            target: recoveryResetLedger.tokenDigest,
          })
          .pipe(
            Effect.as(true),
            Effect.mapError((cause) => unavailable('password-reset-token-register', cause)),
          );
      },
    );

    const peekLedgerByIdentifierPrefix = Effect.fn('CommercePortalAuthRecoveryStore.peekLedgerByIdentifierPrefix')(
      function* peekLedgerByIdentifierPrefixEffect(
        prefix: string,
        token: Redacted.Redacted,
      ): Effect.fn.Return<
        Option.Option<CommercePortalAuthRecoveryLedgerBinding>,
        CommercePortalAuthRecoveryUnavailable
      > {
        const digest = yield* digestToken(crypto, token).pipe(
          Effect.mapError((cause) => unavailable('recovery-ledger-peek-hash', cause)),
        );
        const now = yield* DateTime.nowAsDate;
        const identifier = `${prefix}${digest}`;
        // An expired token can no longer verify anything, so it must not be evidence either:
        // admitting one would let a long-dead token open a support reconciliation row on demand.
        // The statement's own clock decides, exactly as the reset ledger's peek does.
        const rows = yield* database
          .select({ value: verification.value })
          .from(verification)
          .where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, now)))
          .pipe(Effect.mapError((cause) => unavailable('recovery-ledger-peek', cause)));
        const decoded = rows.flatMap((row) => {
          const record = decodeVerificationLedgerRecord(row.value);
          return Option.isSome(record) ? [record.value] : [];
        });
        if (decoded.length === 0) {
          return Option.none();
        }
        const distinct = decoded.filter(
          (record, index) =>
            decoded.findIndex(
              (candidate) =>
                candidate.providerSubjectId === record.providerSubjectId && candidate.email === record.email,
            ) === index,
        );
        if (distinct.length === 1) {
          const [record] = distinct;
          return record === undefined ? Option.none() : Option.some({ ...record, tokenDigest: digest });
        }
        // The raw token text collided across more than one distinct subject/email pairing (Better
        // Auth's verification tokens are deterministic per secret/email/issuance-second, so two
        // registrations within the same second produce byte-identical tokens). Evidence is still
        // resolvable when exactly one candidate names a subject that no longer owns any account:
        // staleness is always the more specific, more urgent fact (see
        // `detectRecoveryReconciliationConflict`), so that candidate is the binding. Anything else
        // (no stale candidate, or more than one) is unresolved evidence: detection reports nothing
        // rather than guessing which candidate applies.
        const existingSubjects = yield* database
          .select({ id: user.id })
          .from(user)
          .where(
            inArray(
              user.id,
              distinct.map((record) => record.providerSubjectId),
            ),
          )
          .pipe(Effect.mapError((cause) => unavailable('recovery-ledger-peek-ambiguous', cause)));
        const existingSubjectIds = new Set(existingSubjects.map((row) => row.id));
        const staleCandidates = distinct.filter((record) => !existingSubjectIds.has(record.providerSubjectId));
        if (staleCandidates.length === 1) {
          const [staleCandidate] = staleCandidates;
          return staleCandidate === undefined ? Option.none() : Option.some({ ...staleCandidate, tokenDigest: digest });
        }
        return Option.none();
      },
    );

    /** Non-destructive: reads the email-verification ledger's issuance-time binding for a token. */
    const peekEmailVerificationLedger = (input: { readonly token: Redacted.Redacted }) =>
      peekLedgerByIdentifierPrefix(EMAIL_VERIFICATION_IDENTIFIER_PREFIX, input.token);

    /**
     * Non-destructive: reads the password-reset ledger's issuance-time binding for a token.
     * Excludes any row that is not `pending` or whose expiry has already passed — a terminal
     * (`expired` by the sweep, `consumed` by a completed reset) row's `providerSubjectId`/`email`
     * were already cleared where they were written, but this filter is what actually keeps the row
     * out of lookups even for the instant between expiry and the next sweep: an expired or already
     * spent row is never returned here regardless of whether it has been swept yet. A `dispatched`
     * row is excluded by the same guard and for the same reason a `consumed` one is: the provider
     * has already been asked to spend that token, so this submission caused no drift to reconcile.
     * `peekDispatchedPasswordResetLedger` is the read that deliberately does see those rows.
     */
    const peekPasswordResetLedger = Effect.fn('CommercePortalAuthRecoveryStore.peekPasswordResetLedger')(
      function* peekPasswordResetLedgerEffect(input: {
        readonly token: Redacted.Redacted;
      }): Effect.fn.Return<
        Option.Option<CommercePortalAuthRecoveryLedgerBinding>,
        CommercePortalAuthRecoveryUnavailable
      > {
        const now = yield* DateTime.nowAsDate;
        const tokenDigest = yield* digestToken(crypto, input.token).pipe(
          Effect.mapError((cause) => unavailable('password-reset-ledger-peek-hash', cause)),
        );
        const rows = yield* database
          .select({ email: recoveryResetLedger.email, providerSubjectId: recoveryResetLedger.providerSubjectId })
          .from(recoveryResetLedger)
          .where(
            and(
              eq(recoveryResetLedger.tokenDigest, tokenDigest),
              eq(recoveryResetLedger.state, RESET_LEDGER_STATE_PENDING),
              gt(recoveryResetLedger.expiresAt, now),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => unavailable('password-reset-ledger-peek', cause)));
        const [row] = rows;
        if (row === undefined || row.email === null || row.providerSubjectId === null) {
          return Option.none();
        }
        return Option.some({ email: row.email, providerSubjectId: row.providerSubjectId, tokenDigest });
      },
    );

    /**
     * The claim taken immediately before Better Auth is asked to spend the token, in a transaction
     * of its own so it is durable whatever happens to the provider call next. Better Auth deletes
     * its own token row inside `resetPassword`, so a call that times out after that commit leaves
     * this realm with no way to tell a reset that never started from one that finished. A row left
     * `pending` would make the customer's retry read as a confident `INVALID_TOKEN` rejection; a
     * `dispatched` row is what turns that same retry into a reconciliation a support operator sees.
     * The guard on `pending` makes the claim happen once, and the expiry guard keeps a long-dead
     * token from opening one.
     *
     * The answer is derived from the rows the guarded `UPDATE` actually returned, since two
     * submissions of the same link race here and the loser's zero-row update is a refusal, not a
     * claim.
     */
    const dispatchPasswordResetLedger = Effect.fn('CommercePortalAuthRecoveryStore.dispatchPasswordResetLedger')(
      function* dispatchPasswordResetLedgerEffect(input: {
        readonly token: Redacted.Redacted;
      }): Effect.fn.Return<CommercePortalAuthRecoveryResetClaim, CommercePortalAuthRecoveryUnavailable> {
        const now = yield* DateTime.nowAsDate;
        const tokenDigest = yield* digestToken(crypto, input.token).pipe(
          Effect.mapError((cause) => unavailable('password-reset-ledger-dispatch-hash', cause)),
        );
        const claimed = yield* database
          .update(recoveryResetLedger)
          .set({ dispatchedAt: now, state: RESET_LEDGER_STATE_DISPATCHED, updatedAt: now })
          .where(
            and(
              eq(recoveryResetLedger.tokenDigest, tokenDigest),
              eq(recoveryResetLedger.state, RESET_LEDGER_STATE_PENDING),
              gt(recoveryResetLedger.expiresAt, now),
            ),
          )
          .returning({ tokenDigest: recoveryResetLedger.tokenDigest })
          .pipe(Effect.mapError((cause) => unavailable('password-reset-ledger-dispatch', cause)));
        if (claimed.length > 0) {
          return 'claimed';
        }
        const rows = yield* database
          .select({ state: recoveryResetLedger.state })
          .from(recoveryResetLedger)
          .where(eq(recoveryResetLedger.tokenDigest, tokenDigest))
          .limit(1)
          .pipe(Effect.mapError((cause) => unavailable('password-reset-ledger-dispatch-state', cause)));
        return rows[0]?.state === RESET_LEDGER_STATE_DISPATCHED ? 'already-dispatched' : 'not-pending';
      },
    );

    /**
     * The claim, given back, once a rejection proves the token is still spendable. Guarded on
     * `dispatched` so it can never revive a `consumed` or `expired` row, or one someone else has
     * since claimed.
     */
    const releasePasswordResetLedger = Effect.fn('CommercePortalAuthRecoveryStore.releasePasswordResetLedger')(
      function* releasePasswordResetLedgerEffect(input: {
        readonly token: Redacted.Redacted;
      }): Effect.fn.Return<void, CommercePortalAuthRecoveryUnavailable> {
        const now = yield* DateTime.nowAsDate;
        const tokenDigest = yield* digestToken(crypto, input.token).pipe(
          Effect.mapError((cause) => unavailable('password-reset-ledger-release-hash', cause)),
        );
        yield* database
          .update(recoveryResetLedger)
          .set({ dispatchedAt: null, state: RESET_LEDGER_STATE_PENDING, updatedAt: now })
          .where(
            and(
              eq(recoveryResetLedger.tokenDigest, tokenDigest),
              eq(recoveryResetLedger.state, RESET_LEDGER_STATE_DISPATCHED),
            ),
          )
          .pipe(Effect.mapError((cause) => unavailable('password-reset-ledger-release', cause)));
      },
    );

    /**
     * The claimed row's binding, read for the one question a lost provider answer leaves open. No
     * expiry filter: the token itself is unusable once it expires, but whether the dispatch that
     * claimed it changed the password is still unknown, and that is what a support operator needs.
     * `consumed` and `expired` rows are excluded by the state guard — both are settled outcomes.
     */
    const peekDispatchedPasswordResetLedger = Effect.fn(
      'CommercePortalAuthRecoveryStore.peekDispatchedPasswordResetLedger',
    )(function* peekDispatchedPasswordResetLedgerEffect(input: {
      readonly token: Redacted.Redacted;
    }): Effect.fn.Return<
      Option.Option<CommercePortalAuthRecoveryLedgerBinding>,
      CommercePortalAuthRecoveryUnavailable
    > {
      const tokenDigest = yield* digestToken(crypto, input.token).pipe(
        Effect.mapError((cause) => unavailable('password-reset-ledger-dispatch-peek-hash', cause)),
      );
      const rows = yield* database
        .select({ email: recoveryResetLedger.email, providerSubjectId: recoveryResetLedger.providerSubjectId })
        .from(recoveryResetLedger)
        .where(
          and(
            eq(recoveryResetLedger.tokenDigest, tokenDigest),
            eq(recoveryResetLedger.state, RESET_LEDGER_STATE_DISPATCHED),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError((cause) => unavailable('password-reset-ledger-dispatch-peek', cause)));
      const [row] = rows;
      if (row === undefined || row.email === null || row.providerSubjectId === null) {
        return Option.none();
      }
      return Option.some({ email: row.email, providerSubjectId: row.providerSubjectId, tokenDigest });
    });

    /**
     * Terminal state for a token Better Auth has already spent, written together with the reset's
     * completion evidence. Without the terminal state the row stays claimed until it expires, so a
     * customer who re-submits the confirmation link they just used would have that spent token
     * reconciled against the account's *current* state — and a legitimate address change or account
     * deletion in between would open a support conflict for a token that changed nothing. Without
     * the audit row in the same transaction the opposite is possible: a password changed behind an
     * audit trail with no row for it. The guard admits `pending` as well as `dispatched` so the
     * happy path is one transition either way.
     */
    const consumePasswordResetLedgerWithAudit = Effect.fn(
      'CommercePortalAuthRecoveryStore.consumePasswordResetLedgerWithAudit',
    )(function* consumePasswordResetLedgerWithAuditEffect(input: {
      readonly audit: CommercePortalAuthAuditEvent;
      readonly token: Redacted.Redacted;
    }): Effect.fn.Return<void, CommercePortalAuthRecoveryUnavailable> {
      const now = yield* DateTime.nowAsDate;
      const tokenDigest = yield* digestToken(crypto, input.token).pipe(
        Effect.mapError((cause) => unavailable('password-reset-ledger-consume-hash', cause)),
      );
      yield* database
        .transaction(
          Effect.fn('CommercePortalAuthRecoveryStore.consumePasswordResetLedgerWithAudit.transaction')(
            function* consumeTransaction(transaction) {
              yield* transaction
                .update(recoveryResetLedger)
                .set({ email: null, providerSubjectId: null, state: RESET_LEDGER_STATE_CONSUMED, updatedAt: now })
                .where(
                  and(
                    eq(recoveryResetLedger.tokenDigest, tokenDigest),
                    inArray(recoveryResetLedger.state, [RESET_LEDGER_STATE_PENDING, RESET_LEDGER_STATE_DISPATCHED]),
                  ),
                );
              yield* writeCommercePortalAuthAuditRow(transaction, input.audit);
            },
          ),
        )
        .pipe(Effect.mapError((cause) => mutationFailure('password-reset-ledger-consume', cause)));
    });

    const findAccountSubjectForEmail = Effect.fn('CommercePortalAuthRecoveryStore.findAccountSubjectForEmail')(
      function* findAccountSubjectForEmailEffect(input: {
        readonly email: string;
      }): Effect.fn.Return<Option.Option<string>, CommercePortalAuthRecoveryUnavailable> {
        const rows = yield* database
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, normalizeCommercePortalAuthEmail(input.email)))
          .limit(1)
          .pipe(Effect.mapError((cause) => unavailable('recovery-account-lookup', cause)));
        const [row] = rows;
        return row === undefined ? Option.none() : Option.some(row.id);
      },
    );

    const accountExists = Effect.fn('CommercePortalAuthRecoveryStore.accountExists')(
      function* accountExistsEffect(input: {
        readonly providerSubjectId: string;
      }): Effect.fn.Return<boolean, CommercePortalAuthRecoveryUnavailable> {
        const rows = yield* database
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, input.providerSubjectId))
          .limit(1)
          .pipe(Effect.mapError((cause) => unavailable('recovery-account-exists', cause)));
        return rows.length === 1;
      },
    );

    /**
     * Writing this row is the only effect detection ever has: it never updates `user`, `session` or
     * `account`. A duplicate detection of the same conflict dedupes onto the same row (the unique
     * index over operation/subject/email/conflictClass) rather than growing without bound.
     */
    const recordRecoveryReconciliation = Effect.fn('CommercePortalAuthRecoveryStore.recordRecoveryReconciliation')(
      function* recordRecoveryReconciliationEffect(input: {
        readonly conflictClass: CommercePortalAuthRecoveryReconciliationConflictClass;
        readonly currentProviderSubjectId: Option.Option<string>;
        readonly email: string;
        readonly operation: string;
        readonly providerSubjectId: string;
      }): Effect.fn.Return<void, CommercePortalAuthRecoveryUnavailable> {
        const now = yield* DateTime.nowAsDate;
        const id = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => unavailable('recovery-reconciliation-id', cause)),
        );
        yield* insertRecoveryReconciliationRow(database, {
          conflictClass: input.conflictClass,
          createdAt: now,
          currentProviderSubjectId: input.currentProviderSubjectId,
          email: input.email,
          id,
          operation: input.operation,
          providerSubjectId: input.providerSubjectId,
        }).pipe(Effect.mapError((cause) => unavailable('recovery-reconciliation-record', cause)));
      },
    );

    return {
      accountExists,
      consumeEmailVerificationWithAudit,
      consumePasswordResetLedgerWithAudit,
      consumeRateLimitBudget,
      dispatchPasswordResetLedger,
      findAccountSubjectForEmail,
      peekDispatchedPasswordResetLedger,
      peekEmailVerificationLedger,
      peekPasswordResetLedger,
      recordRecoveryReconciliation,
      registerEmailVerificationToken,
      registerPasswordResetToken,
      releasePasswordResetLedger,
      reserveEmailVerificationSubject,
    };
  },
);

/** The provider database stays a visible requirement; the composition root supplies it once. */
export const CommercePortalAuthRecoveryStoreLive = Layer.effect(
  CommercePortalAuthRecoveryStoreService,
  Effect.gen(function* makeRecoveryStoreLive() {
    const database = yield* CommercePortalAuthDatabase;
    return yield* makeCommercePortalAuthRecoveryStore(database.executor);
  }),
);
