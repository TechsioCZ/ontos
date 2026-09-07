import { Option, Predicate, Schema } from 'effect';

const PostgresFailureCodeSchema = Schema.Struct({ code: Schema.String });
const PostgresFailureConstraintSchema = Schema.Struct({ constraint: Schema.String });
const CauseWrapperSchema = Schema.Struct({ cause: Schema.Unknown });
export type PostgresFailureMetadata = Readonly<{
  readonly code: string;
  readonly constraint?: string;
}>;
type PostgresFailureInput = Schema.Schema.Type<typeof Schema.Unknown>;
type PostgresFailurePredicate = (metadata: Readonly<PostgresFailureMetadata>) => boolean;

const decodePostgresFailureCode = Schema.decodeUnknownOption(PostgresFailureCodeSchema);
const decodePostgresFailureConstraint = Schema.decodeUnknownOption(PostgresFailureConstraintSchema);
const decodeCauseWrapper = Schema.decodeUnknownOption(CauseWrapperSchema);

/**
 * Finds sanitized technical PostgreSQL metadata without assigning it domain meaning.
 * PostgreSQL code 23505 is a uniqueness signal, not a universal public conflict.
 */
export const findPostgresFailure = (
  input: PostgresFailureInput,
  predicate: PostgresFailurePredicate = () => true,
): Option.Option<Readonly<PostgresFailureMetadata>> => {
  let current = input;
  const visited = new Set<object>();

  while (Predicate.isObjectKeyword(current) && current !== null && !visited.has(current)) {
    visited.add(current);
    const code = decodePostgresFailureCode(current);
    if (Option.isSome(code)) {
      const constraint = decodePostgresFailureConstraint(current);
      const metadata: PostgresFailureMetadata = Option.isSome(constraint)
        ? { code: code.value.code, constraint: constraint.value.constraint }
        : { code: code.value.code };
      const sanitizedMetadata = Object.freeze(metadata);
      if (predicate(sanitizedMetadata)) {
        return Option.some(sanitizedMetadata);
      }
    }

    const wrapper = decodeCauseWrapper(current);
    if (Option.isNone(wrapper)) {
      return Option.none();
    }
    const nestedCause = wrapper.value.cause;
    if (!Predicate.isObjectKeyword(nestedCause) || nestedCause === null) {
      return Option.none();
    }
    current = nestedCause;
  }

  return Option.none();
};
