import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Option, Predicate, Schema } from 'effect';
import { Hex } from 'effect/encoding';

const encodeScalarOption = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
/** Values JSON cannot carry (`undefined`, functions, symbols) render as `null`, exactly as before. */
const encodeScalar = <Value>(value: Value) => Option.getOrElse(encodeScalarOption(value), () => 'null');
/** Structural, key-order independent rendering of any owner document; the hashed shape is the caller's. */
const canonical = <Document>(value: Document): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (Predicate.isObjectKeyword(value)) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${encodeScalar(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return encodeScalar(value);
};
export const stableRevision = <Document>(value: Document) => Hex.encode(sha256(utf8ToBytes(canonical(value))));
