import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Predicate, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';

export const canonicalFingerprintJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map(canonicalFingerprintJson);
  }
  if (Predicate.isObject(value)) {
    // SAFETY: domain encoding supplies JSON; arrays were handled above.
    const record = value as Readonly<Record<string, Schema.Json>>;
    return Object.fromEntries(
      Object.entries(record)
        .toSorted(([left], [right]) => {
          if (left === right) {
            return 0;
          }
          return left < right ? -1 : 1;
        })
        .map(([key, child]) => [key, canonicalFingerprintJson(child)]),
    );
  }
  return value;
};
export const fingerprintPartySourceEffect = (value: Schema.Json) =>
  Hex.encode(
    sha256(
      utf8ToBytes(
        Result.getOrThrow(Schema.encodeResult(Schema.fromJsonString(Schema.Json))(canonicalFingerprintJson(value))),
      ),
    ),
  );
