import { Option } from 'effect';
import { findPostgresFailure } from '../database/postgres-failure.ts';
import type { PostgresFailureMetadata } from '../database/postgres-failure.ts';
// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This imports the pure persistence adapter constructor mandated by #362, not an Effect service constructor.
import { makePersistenceAttempt } from './attempt.ts';

export interface MutationPersistenceRule<Failure> {
  readonly makeFailure: (failure: PostgresFailureMetadata) => Failure;
  readonly matches: (failure: PostgresFailureMetadata) => boolean;
}

type MutationPersistenceRuleFailure<Rule> =
  Rule extends MutationPersistenceRule<infer Failure> ? Failure : never;

export interface MutationPersistenceAttemptOptions<
  Rules extends readonly MutationPersistenceRule<unknown>[],
  FallbackFailure,
> {
  readonly fallback: (cause: unknown) => FallbackFailure;
  readonly rules: readonly MutationPersistenceRule<
    MutationPersistenceRuleFailure<Rules[number]>
  >[] &
    Rules;
}

/**
 * Builds a lazy persistence attempt with owner-defined PostgreSQL classifications.
 * Rules run in declaration order; the first match wins and every other failure uses the required
 * owner fallback. This constructor deliberately assigns no meaning to PostgreSQL codes or names.
 */
export const makeMutationPersistenceAttempt = <
  const Rules extends readonly MutationPersistenceRule<unknown>[],
  FallbackFailure,
>(
  options: MutationPersistenceAttemptOptions<Rules, FallbackFailure>,
) =>
  makePersistenceAttempt(
    (cause): MutationPersistenceRuleFailure<Rules[number]> | FallbackFailure => {
      for (const rule of options.rules) {
        const postgresFailure = findPostgresFailure(cause, rule.matches);
        if (Option.isSome(postgresFailure)) {
          return rule.makeFailure(postgresFailure.value);
        }
      }
      return options.fallback(cause);
    },
  );
