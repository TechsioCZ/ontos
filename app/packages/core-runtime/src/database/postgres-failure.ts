import { Cause, Option, Predicate, Schema } from 'effect';

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

const enqueueFailureReasons = (cause: Cause.Cause<unknown>, pending: unknown[]): void => {
  for (const reason of cause.reasons.toReversed()) {
    if (Cause.isFailReason(reason)) {
      pending.push(reason.error);
    } else if (Cause.isDieReason(reason)) {
      pending.push(reason.defect);
    }
  }
};

const decodeFailureMetadata = (
  current: PostgresFailureInput,
): Option.Option<Readonly<PostgresFailureMetadata>> =>
  Option.map(decodePostgresFailureCode(current), ({ code }) => {
    const constraint = decodePostgresFailureConstraint(current);
    const metadata: PostgresFailureMetadata = Option.isSome(constraint)
      ? { code, constraint: constraint.value.constraint }
      : { code };
    return Object.freeze(metadata);
  });

/**
 * Finds sanitized technical PostgreSQL metadata without assigning it domain meaning.
 * PostgreSQL code 23505 is a uniqueness signal, not a universal public conflict.
 */
export const findPostgresFailure = (
  input: PostgresFailureInput,
  predicate: PostgresFailurePredicate = () => true,
): Option.Option<Readonly<PostgresFailureMetadata>> => {
  const pending: unknown[] = [input];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!Predicate.isObjectKeyword(current) || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (Cause.isCause(current)) {
      enqueueFailureReasons(current, pending);
    } else {
      const metadata = Option.filter(decodeFailureMetadata(current), predicate);
      if (Option.isSome(metadata)) {
        return metadata;
      }

      const wrapper = decodeCauseWrapper(current);
      if (Option.isSome(wrapper)) {
        pending.push(wrapper.value.cause);
      }
    }
  }

  return Option.none();
};
