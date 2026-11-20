import { findPostgresFailure } from '@app/core-runtime';
import { Option, Schema } from 'effect';

import { withCause } from '../problems-support.ts';

/**
 * What an "unavailable" error of the secret-bearing Auth paths may keep of the failure it replaces.
 *
 * A database failure carries the attempted statement: the driver's error message holds the SQL text and every bound parameter, and
 * Better Auth's own errors hold request material. The paths that handle a live one-time code, a verification or reset token, or a
 * link must never let any of that reach an error `cause`, an Effect `Cause`, a log line or a defect report, whatever the failure
 * says. The cause is therefore REPLACED, never wrapped: only the failure's own kind and, for PostgreSQL, the sanitized SQLSTATE
 * and constraint name that Core extracts. The kept value is a plain object of short literals.
 */
export interface SafeFailure {
  readonly constraint?: string;
  readonly kind: string;
  readonly sqlState?: string;
}

const decodeTag = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }));
const decodeName = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }));

const kindOf = (cause: unknown): string =>
  decodeTag(cause).pipe(
    Option.map(({ _tag }) => _tag),
    Option.orElse(() => Option.map(decodeName(cause), ({ name }) => name)),
    Option.getOrElse(() => 'unknown'),
  );

/** The failure's own kind, and the SQLSTATE and constraint of a PostgreSQL failure; nothing it contains. */
export const safeFailureOf = (cause: unknown): SafeFailure => {
  const kind = kindOf(cause);
  return Option.match(findPostgresFailure(cause), {
    onNone: () => ({ kind }),
    onSome: ({ code, constraint }) =>
      constraint === undefined ? { kind, sqlState: code } : { constraint, kind, sqlState: code },
  });
};

/** Attaches ONLY the safe kind of `cause` to a typed error (non-enumerable, like every portal-auth cause). */
export const withSafeCause = <Value extends object>(value: Value, cause: unknown): Value =>
  withCause(value, safeFailureOf(cause));
