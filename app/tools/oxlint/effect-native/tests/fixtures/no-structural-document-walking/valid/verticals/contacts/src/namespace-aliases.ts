import * as P from 'effect/Predicate';
import * as Schema from 'effect/Schema';

/** A real `effect/Predicate` namespace alias applied to a plain local: not a document probe. */
export const isRecordValue = (input: unknown): boolean => P.isRecord(input);

/** A local helper bag that merely shares the name `Predicate` — not `effect/Predicate`. */
const Predicate = {
  isObjectKeyword: (value: unknown): boolean => value !== null,
  isString: (value: unknown): boolean => typeof value === 'string',
};

export const nameOf = (record: Record<string, unknown>): boolean => Predicate.isString(record['name']);

export const NameSchema = Schema.Struct({ name: Schema.String });
