import { findPostgresFailure } from '@app/core-runtime';
import { Option, Schema } from 'effect';

/**
 * What a typed "unavailable" error may keep of the failure it replaces.
 *
 * A database or owner failure carries the whole attempted statement: Drizzle's query error message holds the SQL text
 * and every bound parameter, so a failed insert of an intent would put the recipient reference, the contact reference
 * and the owner's mask into any log that prints the error's `cause`. None of that is needed to diagnose an outage, so
 * the cause is REPLACED, never wrapped: only the failure's own kind and, for PostgreSQL, the sanitized SQLSTATE and
 * constraint name that Core extracts. The stored value is a plain object of short literals.
 */
export interface SafeCause {
  readonly constraint?: string;
  readonly kind: string;
  readonly sqlState?: string;
}

const decodeTag = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }));
const decodeName = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }));

/** The failure's own tag, else its error name, else nothing more: a value is never described by what it contains. */
const kindOf = (cause: unknown): string =>
  decodeTag(cause).pipe(
    Option.map(({ _tag }) => _tag),
    Option.orElse(() => Option.map(decodeName(cause), ({ name }) => name)),
    Option.getOrElse(() => 'unknown'),
  );

export const safeCauseOf = (cause: unknown): SafeCause => {
  const postgres = findPostgresFailure(cause);
  const kind = kindOf(cause);
  return Option.match(postgres, {
    onNone: () => ({ kind }),
    onSome: ({ code, constraint }) =>
      constraint === undefined ? { kind, sqlState: code } : { constraint, kind, sqlState: code },
  });
};
