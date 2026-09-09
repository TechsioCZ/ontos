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

export const decodeDatabaseDriverFailure = (input: DatabaseDriverFailureInput): Option.Option<DatabaseDriverFailure> =>
  Option.flatMap(
    findPostgresFailure(input, ({ code }) => Option.isSome(decodeDriverCodeFailure(code))),
    ({ code }) => decodeDriverCodeFailure(code),
  );

export const isDatabaseUnavailableFailure = (input: DatabaseDriverFailureInput): boolean =>
  Option.exists(decodeDatabaseDriverFailure(input), ({ code }) => isUnavailableDriverCode(code));

export const isDatabaseCommitAcknowledgementAmbiguous = (input: DatabaseDriverFailureInput): boolean =>
  Option.exists(decodeDatabaseDriverFailure(input), Schema.is(DatabaseCommitAcknowledgementAmbiguous));
