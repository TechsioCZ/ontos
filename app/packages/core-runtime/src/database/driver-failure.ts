import { Option, Schema } from 'effect';

import { findPostgresFailure } from './postgres-failure.ts';

export const DatabaseDriverFailureKindSchema = Schema.Literals(['socket', 'sqlstate']);
export type DatabaseDriverFailureKind = Schema.Schema.Type<typeof DatabaseDriverFailureKindSchema>;

const driverFailureFields = {
  code: Schema.String,
  kind: DatabaseDriverFailureKindSchema,
};

const DatabaseCommitAcknowledgementAmbiguousContract = Schema.TaggedStruct(
  'DatabaseCommitAcknowledgementAmbiguous',
  driverFailureFields,
);
type DatabaseCommitAcknowledgementAmbiguousSelf = Schema.Schema.Type<
  typeof DatabaseCommitAcknowledgementAmbiguousContract
>;
export const DatabaseCommitAcknowledgementAmbiguous = Schema.TaggedError<DatabaseCommitAcknowledgementAmbiguousSelf>()(
  'DatabaseCommitAcknowledgementAmbiguous',
  driverFailureFields,
);

const DatabaseTransactionFailureContract = Schema.TaggedStruct('DatabaseTransactionFailure', driverFailureFields);
type DatabaseTransactionFailureSelf = Schema.Schema.Type<typeof DatabaseTransactionFailureContract>;
export const DatabaseTransactionFailure = Schema.TaggedError<DatabaseTransactionFailureSelf>()(
  'DatabaseTransactionFailure',
  driverFailureFields,
);

const DatabaseDriverUnavailableFailureContract = Schema.TaggedStruct(
  'DatabaseDriverUnavailableFailure',
  driverFailureFields,
);
type DatabaseDriverUnavailableFailureSelf = Schema.Schema.Type<typeof DatabaseDriverUnavailableFailureContract>;
export const DatabaseDriverUnavailableFailure = Schema.TaggedError<DatabaseDriverUnavailableFailureSelf>()(
  'DatabaseDriverUnavailableFailure',
  driverFailureFields,
);

export const DatabaseDriverFailureSchema = Schema.Union([
  DatabaseCommitAcknowledgementAmbiguous,
  DatabaseTransactionFailure,
  DatabaseDriverUnavailableFailure,
]);
export type DatabaseDriverFailure = Schema.Schema.Type<typeof DatabaseDriverFailureSchema>;
export const DatabaseDriverFailureInputSchema = Schema.Unknown;
export type DatabaseDriverFailureInput = Schema.Schema.Type<typeof DatabaseDriverFailureInputSchema>;

const connectionSqlStateClass = ['0', '8'].join('');
const transactionSqlStateClass = ['4', '0'].join('');
const administrativeShutdownSqlState = ['57', 'P01'].join('');
/** Every integrity constraint PostgreSQL can refuse a write with: unique, check, foreign key, null. */
const integritySqlStateClass = ['2', '3'].join('');
/** `object_not_in_prerequisite_state`: the access triggers' own refusal of a forward-only write. */
const accessTriggerRefusalSqlState = ['55', '000'].join('');
const unavailableSqlStateClasses = new Set<string>(['08', '40', '53', '55', '57', '58']);
const unavailableSocketCodes = new Set<string>('ECONNREFUSED ECONNRESET EPIPE ETIMEDOUT'.split(' '));
const commitAcknowledgementSocketCodes = new Set<string>(
  'ECONNABORTED ECONNRESET EHOSTDOWN EHOSTUNREACH ENETDOWN ENETRESET ENETUNREACH EPIPE ETIMEDOUT'.split(' '),
);

const decodeDriverCodeFailure = (code: string): Option.Option<DatabaseDriverFailure> => {
  const sqlStateClass = code.slice(0, 2);
  if (sqlStateClass === connectionSqlStateClass || code === administrativeShutdownSqlState) {
    return Option.some(new DatabaseCommitAcknowledgementAmbiguous({ code, kind: 'sqlstate' }));
  }
  if (commitAcknowledgementSocketCodes.has(code)) {
    return Option.some(new DatabaseCommitAcknowledgementAmbiguous({ code, kind: 'socket' }));
  }
  if (sqlStateClass === transactionSqlStateClass) {
    return Option.some(new DatabaseTransactionFailure({ code, kind: 'sqlstate' }));
  }
  if (unavailableSqlStateClasses.has(sqlStateClass)) {
    return Option.some(new DatabaseDriverUnavailableFailure({ code, kind: 'sqlstate' }));
  }
  return unavailableSocketCodes.has(code)
    ? Option.some(new DatabaseDriverUnavailableFailure({ code, kind: 'socket' }))
    : Option.none();
};

const isUnavailableDriverCode = (code: string): boolean =>
  unavailableSqlStateClasses.has(code.slice(0, 2)) || unavailableSocketCodes.has(code);

/**
 * A code naming a refusal PostgreSQL proves about the data itself, so no retry can ever succeed.
 *
 * Class 23 is every integrity constraint (`23505` a uniqueness collision, `23514` a check, `23503` a
 * foreign key, `23502` a not-null); `55000` is the access triggers' own refusal of a write that would
 * break their forward-only rules, which is evaluated at commit time for the deferred ones. Every
 * other class-55 code stays transient — a `55P03` lock is simply not available yet — so only the
 * exact `55000` joins the permanent set here.
 */
const isIntegrityRefusalCode = (code: string): boolean =>
  code.slice(0, 2) === integritySqlStateClass || code === accessTriggerRefusalSqlState;

export const decodeDatabaseDriverFailure = (input: DatabaseDriverFailureInput): Option.Option<DatabaseDriverFailure> =>
  Option.flatMap(
    findPostgresFailure(input, ({ code }) => Option.isSome(decodeDriverCodeFailure(code))),
    ({ code }) => decodeDriverCodeFailure(code),
  );

/**
 * A write PostgreSQL refused for good: the record contradicts an integrity constraint, or an access
 * trigger proved it would break a rule the table keeps. Such a failure is never retryable
 * unavailability, so a store classifies it before {@link isDatabaseUnavailableFailure} and reports a
 * non-retryable refusal instead of inviting the caller to try the same write again (R4-M1).
 */
export const isDatabaseIntegrityRefusal = (input: DatabaseDriverFailureInput): boolean =>
  Option.exists(
    findPostgresFailure(input, ({ code }) => isIntegrityRefusalCode(code)),
    ({ code }) => isIntegrityRefusalCode(code),
  );

export const isDatabaseUnavailableFailure = (input: DatabaseDriverFailureInput): boolean =>
  Option.exists(decodeDatabaseDriverFailure(input), ({ code }) => isUnavailableDriverCode(code));

/**
 * True exactly for an access guard's own `55000`: the trigger that keeps a table forward-only refused
 * the write. A store names the rule that refused it instead of the general integrity class, so the
 * owner-facing code says "this operation went backwards" rather than "a constraint failed" (R4-M1).
 */
export const isDatabaseGuardRefusal = (input: DatabaseDriverFailureInput): boolean =>
  Option.exists(
    findPostgresFailure(input, ({ code }) => code === accessTriggerRefusalSqlState),
    ({ code }) => code === accessTriggerRefusalSqlState,
  );

export const isDatabaseCommitAcknowledgementAmbiguous = (input: DatabaseDriverFailureInput): boolean =>
  Option.exists(decodeDatabaseDriverFailure(input), Schema.is(DatabaseCommitAcknowledgementAmbiguous));
