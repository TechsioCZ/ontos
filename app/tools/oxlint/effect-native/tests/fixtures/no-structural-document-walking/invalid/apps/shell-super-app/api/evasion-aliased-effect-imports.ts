// expect-count: 2
import { isRecord as isRecordLike, isString as isStringValue } from 'effect/Predicate';

/** The same `effect/Predicate` object guard, imported under an alias. */
export const bagOf = (value: unknown): boolean => isRecordLike(value) && !Array.isArray(value);

/** The same field guard, imported under an alias. */
export const nameOf = (record: Record<string, unknown>): boolean => isStringValue(record['name']);
