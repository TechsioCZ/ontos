import { and, desc, eq, gt, inArray, like, lt, sql } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';

import {
  CommercePortalAuthProviderSubjectIdSchema,
  CommercePortalAuthRecoveryReconciliationConflictClassSchema,
} from '../../../api/portal-auth/provider/recovery/contracts.ts';
import type {
  CommercePortalAuthEmailVerificationTokenRegistration,
  CommercePortalAuthRecoveryReconciliationConflictClass,
} from '../../../api/portal-auth/provider/recovery/contracts.ts';
import { withCause } from '../../../api/portal-auth/problems-support.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../../../api/portal-auth/rate-limit-service.ts';
import { CommercePortalAuthRecoveryUnavailable } from '../../../api/portal-auth/provider/recovery/unavailable.ts';
import { CommercePortalAuthRecoveryStoreService } from '../../../api/portal-auth/provider/recovery/store-service.ts';
import type {
  CommercePortalAuthRecoveryLedgerBinding,
  CommercePortalAuthRecoveryReconciliationEntry,
  CommercePortalAuthRecoveryStore,
} from '../../../api/portal-auth/provider/recovery/store-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../../api/portal-auth/provider/config.ts';
import { CommercePortalAuthDatabase } from './portal-auth-database.ts';
import type { CommercePortalAuthDatabaseExecutor } from './portal-auth-database-types.ts';
import { rateLimit, recoveryReconciliation, recoveryResetLedger, user, verification } from './portal-auth-tables.ts';

const EMAIL_VERIFICATION_IDENTIFIER_PREFIX = 'commerce-email-verification:';
const EMAIL_VERIFICATION_RESERVATION_IDENTIFIER_PREFIX = 'commerce-email-verification-pending:';
const RESET_LEDGER_STATE_PENDING = 'pending';
const RESET_LEDGER_STATE_EXPIRED = 'expired';
const RESET_LEDGER_SWEEP_OPERATION = 'recovery-reset-ledger-sweep';
/** A sweep touches at most this many stale rows per call: bounded work, never a table scan. */
const RESET_LEDGER_SWEEP_BATCH_SIZE = 100;
const DEFAULT_RECONCILIATION_ENTRY_LIMIT = 50;
const MAX_RECONCILIATION_ENTRY_LIMIT = 200;
const verificationLedgerEmail = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(3), Schema.isMaxLength(320));
const VerificationLedgerRecordSchema = Schema.Struct({
  email: verificationLedgerEmail,
  providerSubjectId: CommercePortalAuthProviderSubjectIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
type VerificationLedgerRecord = typeof VerificationLedgerRecordSchema.Type;

const unavailable = (operation: string, cause: unknown): CommercePortalAuthRecoveryUnavailable =>
  withCause(
    new CommercePortalAuthRecoveryUnavailable({
      operation,
      reason: `Commerce portal authentication ${operation} could not complete`,
    }),
    cause,
  );

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const normalizeEmail = (email: string): string => email.toLowerCase();

const encodeVerificationLedgerRecord = (input: {
  readonly email: string;
  readonly providerSubjectId: string;
}): string => {
  const email = normalizeEmail(input.email);
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
  return Option.isSome(decoded) && decoded.value.email === normalizeEmail(decoded.value.email)
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
        const reservationDigest = yield* digestText(crypto, normalizeEmail(input.email)).pipe(
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
      const emailDigest = yield* digestText(crypto, normalizeEmail(input.email)).pipe(
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
                    eq(user.email, normalizeEmail(input.email)),
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

    const consumeEmailVerification = Effect.fn('CommercePortalAuthRecoveryStore.consumeEmailVerification')(
      function* consumeEmailVerificationEffect(input: {
        readonly now: Date;
        readonly token: Redacted.Redacted;
      }): Effect.fn.Return<Option.Option<string>, CommercePortalAuthRecoveryUnavailable> {
        const digest = yield* digestToken(crypto, input.token).pipe(
          Effect.mapError((cause) => unavailable('verification-token-hash', cause)),
        );
        const identifier = emailVerificationIdentifier(digest);
        return yield* database
          .transaction(
            Effect.fn('CommercePortalAuthRecoveryStore.consumeEmailVerification.transaction')(
              function* consumeTransaction(transaction) {
                const rows = yield* transaction
                  .delete(verification)
                  .where(eq(verification.identifier, identifier))
                  .returning({ expiresAt: verification.expiresAt, value: verification.value });
                // A provider token is deterministic in the realm secret and the address, so a
                // re-registered address can leave two ledger rows under one identifier bound to two
                // different subjects. `DELETE … RETURNING` has no defined order, so admitting the
                // first row would verify an arbitrary one of them. Both rows are spent here and
                // neither is admitted: an ambiguous binding is refused, never guessed.
                if (rows.length > 1) {
                  return Option.none<string>();
                }
                const [row] = rows;
                if (
                  row === undefined ||
                  !Number.isFinite(epochMillis(row.expiresAt)) ||
                  epochMillis(row.expiresAt) <= epochMillis(input.now)
                ) {
                  return Option.none<string>();
                }

                const record = decodeVerificationLedgerRecord(row.value);
                if (Option.isNone(record)) {
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
                return updated.length === 1 ? Option.some(record.value.providerSubjectId) : Option.none<string>();
              },
            ),
          )
          .pipe(Effect.mapError((cause) => unavailable('verification-token-consume', cause)));
      },
    );

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
     * Bounded housekeeping: a pending row whose expiry has already passed can never satisfy a peek
     * again (`peekPasswordResetLedger` itself also filters on `expiresAt`, so an unswept row is
     * already excluded from lookups — this only makes the exclusion durable). At most
     * `RESET_LEDGER_SWEEP_BATCH_SIZE` rows are touched per call, so this never becomes a table scan.
     * A sweep that fails must not deny the request that triggered it, so its cause is reported and
     * the caller continues.
     */
    const sweepExpiredResetLedgerRows = (now: Date) =>
      Effect.gen(function* sweepExpiredResetLedgerRowsEffect() {
        const stale = database
          .select({ identifierDigest: recoveryResetLedger.identifierDigest })
          .from(recoveryResetLedger)
          .where(and(eq(recoveryResetLedger.state, RESET_LEDGER_STATE_PENDING), lt(recoveryResetLedger.expiresAt, now)))
          .limit(RESET_LEDGER_SWEEP_BATCH_SIZE);
        yield* database
          .update(recoveryResetLedger)
          .set({ email: null, providerSubjectId: null, state: RESET_LEDGER_STATE_EXPIRED, updatedAt: now })
          .where(inArray(recoveryResetLedger.identifierDigest, stale));
      }).pipe(
        Effect.annotateLogs({ operation: RESET_LEDGER_SWEEP_OPERATION }),
        Effect.ignore({ log: true, message: 'Commerce portal recovery reset-ledger sweep failed' }),
      );

    /**
     * Records the issuance-time email/subject binding for a password-reset token, before delivery.
     * This ledger is read-only evidence for reconciliation detection: it is never consumed, and its
     * presence or absence never changes whether Better Auth's own reset flow succeeds.
     *
     * Keyed by `identifierDigest` (the normalized email's digest), so a repeated request for the
     * same identifier within the window always upserts the *same* row instead of inserting a second
     * pending row: no duplicate pending rows are possible, and the store-level behavior — a fresh
     * token digest and expiry replacing the prior ones — is identical whether this is the first
     * request or a retry, so the caller cannot distinguish "no account" from "already requested".
     * An identifier whose prior row had already expired is revived back to `pending` in place.
     */
    const registerPasswordResetToken = Effect.fn('CommercePortalAuthRecoveryStore.registerPasswordResetToken')(
      function* registerPasswordResetTokenEffect(input: {
        readonly email: string;
        readonly expiresAt: Date;
        readonly providerSubjectId: string;
        readonly token: Redacted.Redacted;
      }): Effect.fn.Return<boolean, CommercePortalAuthRecoveryUnavailable> {
        const now = yield* DateTime.nowAsDate;
        const email = normalizeEmail(input.email);
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
              providerSubjectId: input.providerSubjectId,
              state: RESET_LEDGER_STATE_PENDING,
              tokenDigest,
              updatedAt: now,
            },
            target: recoveryResetLedger.identifierDigest,
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
        const identifier = `${prefix}${digest}`;
        const rows = yield* database
          .select({ value: verification.value })
          .from(verification)
          .where(eq(verification.identifier, identifier))
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
          return record === undefined ? Option.none() : Option.some(record);
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
          return staleCandidate === undefined ? Option.none() : Option.some(staleCandidate);
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
     * (expired) row's `providerSubjectId`/`email` were already cleared by the sweep, but this filter
     * is what actually keeps the row out of lookups even for the instant between expiry and the next
     * sweep: an expired row is never returned here regardless of whether it has been swept yet.
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
        return Option.some({ email: row.email, providerSubjectId: row.providerSubjectId });
      },
    );

    const findAccountSubjectForEmail = Effect.fn('CommercePortalAuthRecoveryStore.findAccountSubjectForEmail')(
      function* findAccountSubjectForEmailEffect(input: {
        readonly email: string;
      }): Effect.fn.Return<Option.Option<string>, CommercePortalAuthRecoveryUnavailable> {
        const rows = yield* database
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, normalizeEmail(input.email)))
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
        yield* database
          .insert(recoveryReconciliation)
          .values({
            conflictClass: input.conflictClass,
            createdAt: now,
            currentProviderSubjectId: Option.getOrNull(input.currentProviderSubjectId),
            email: normalizeEmail(input.email),
            id,
            operation: input.operation,
            providerSubjectId: input.providerSubjectId,
          })
          // Target the dedupe unique index, not the primary key: `id` is a fresh UUID on every
          // call and never conflicts, so targeting it would let a repeated detection raise an
          // unhandled unique-violation on `commerce_auth_recovery_reconciliation_dedupe_uk`
          // instead of silently no-op'ing.
          .onConflictDoNothing({
            target: [
              recoveryReconciliation.operation,
              recoveryReconciliation.providerSubjectId,
              recoveryReconciliation.email,
              recoveryReconciliation.conflictClass,
            ],
          })
          .pipe(Effect.mapError((cause) => unavailable('recovery-reconciliation-record', cause)));
      },
    );

    const getRecoveryReconciliationEntries = Effect.fn(
      'CommercePortalAuthRecoveryStore.getRecoveryReconciliationEntries',
    )(function* getRecoveryReconciliationEntriesEffect(input: {
      readonly limit?: number;
    }): Effect.fn.Return<
      readonly CommercePortalAuthRecoveryReconciliationEntry[],
      CommercePortalAuthRecoveryUnavailable
    > {
      const limit = Math.min(
        Math.max(1, input.limit ?? DEFAULT_RECONCILIATION_ENTRY_LIMIT),
        MAX_RECONCILIATION_ENTRY_LIMIT,
      );
      const rows = yield* database
        .select()
        .from(recoveryReconciliation)
        .orderBy(desc(recoveryReconciliation.createdAt))
        .limit(limit)
        .pipe(Effect.mapError((cause) => unavailable('recovery-reconciliation-list', cause)));
      const entries: CommercePortalAuthRecoveryReconciliationEntry[] = [];
      for (const row of rows) {
        const conflictClass = Schema.decodeUnknownOption(CommercePortalAuthRecoveryReconciliationConflictClassSchema)(
          row.conflictClass,
        );
        if (Option.isNone(conflictClass)) {
          continue;
        }
        entries.push({
          conflictClass: conflictClass.value,
          createdAt: row.createdAt,
          currentProviderSubjectId: Option.fromNullOr(row.currentProviderSubjectId),
          email: row.email,
          id: row.id,
          operation: row.operation,
          providerSubjectId: row.providerSubjectId,
        });
      }
      return entries;
    });

    return {
      accountExists,
      consumeEmailVerification,
      consumeRateLimitBudget,
      findAccountSubjectForEmail,
      getRecoveryReconciliationEntries,
      peekEmailVerificationLedger,
      peekPasswordResetLedger,
      recordRecoveryReconciliation,
      registerEmailVerificationToken,
      registerPasswordResetToken,
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
