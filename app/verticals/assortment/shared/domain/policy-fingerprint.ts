import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import type { CreateRulePayload } from '../actions/policy-administration.ts';

const CanonicalJsonSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(CanonicalJsonSchema),
    Schema.Record(Schema.String, CanonicalJsonSchema),
  ]),
);
const CanonicalJsonRecordSchema = Schema.Record(Schema.String, CanonicalJsonSchema);
const JsonStringSchema = Schema.fromJsonString(CanonicalJsonSchema);
const canonicalJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (Schema.is(CanonicalJsonRecordSchema)(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
};
const canonicalize = <Value extends object>(value: Value): string => {
  const decoded = Result.getOrThrow(Schema.decodeUnknownResult(CanonicalJsonSchema)(value));
  return Result.getOrThrow(Schema.encodeResult(JsonStringSchema)(canonicalJson(decoded)));
};

export const assortmentMeaningFingerprint = <Value extends object>(value: Value): string => {
  const canonical = canonicalize(value);
  return Hex.encode(sha256(utf8ToBytes(canonical)));
};

export const ruleMeaning = (input: Pick<CreateRulePayload, 'effect' | 'purpose' | 'selector'>) => ({
  effect: input.effect,
  purpose: input.purpose,
  selector: input.selector,
});
