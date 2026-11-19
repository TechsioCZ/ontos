import { findPostgresFailure } from '@app/core-runtime';
import { Option, Predicate } from 'effect';

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

const kindOf = (cause: unknown): string => {
  if (Predicate.hasProperty(cause, '_tag') && typeof cause._tag === 'string') {
    return cause._tag;
  }
  return cause instanceof Error ? cause.name : typeof cause;
};

export const safeCauseOf = (cause: unknown): SafeCause => {
  const postgres = findPostgresFailure(cause);
  const kind = kindOf(cause);
  return Option.match(postgres, {
    onNone: () => ({ kind }),
    onSome: ({ code, constraint }) =>
      constraint === undefined ? { kind, sqlState: code } : { constraint, kind, sqlState: code },
  });
};
