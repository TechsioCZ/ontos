// expect-count: 6
import { Predicate, Schema } from 'effect';

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

/** Hand-rolled `Schema.Struct` guard: object guard + `Array.isArray` arm. */
export const objectOf = (value: unknown) => {
  if (!Predicate.isObjectKeyword(value) || value === null || Array.isArray(value)) {
    throw new TypeError('expected object');
  }
  return Schema.decodeUnknownSync(JsonObjectSchema)(value);
};

/** The same guard written with `typeof`. */
export const bagOf = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('expected object');
  }
  return raw;
};

export const entriesOf = (record: Record<string, unknown>): readonly unknown[] =>
  Array.isArray(record['verticals']) ? record['verticals'] : [];

export const labelOf = (decoded: { readonly id: unknown }): string =>
  Predicate.isString(decoded.id) ? decoded.id : 'unknown';

export const hasOverlay = (topology: object): boolean => 'overlay' in topology;

export const hasVerticals = (topology: object): boolean => Object.hasOwn(topology, 'verticals');
