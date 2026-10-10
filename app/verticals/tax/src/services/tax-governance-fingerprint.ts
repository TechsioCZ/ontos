import { DateTime, Result, Schema } from 'effect';
import { createHash } from 'node:crypto';

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

/**
 * SHA-256 of the canonical JSON meaning. Key order never changes the fingerprint, so the same governed meaning
 * always yields the same semantic fingerprint (#929 F18, #930 F15).
 */
export const taxMeaningFingerprint = <Value extends object>(value: Value): string => {
  const decoded = Result.getOrThrow(Schema.decodeUnknownResult(CanonicalJsonSchema)(value));
  const canonical = Result.getOrThrow(Schema.encodeResult(JsonStringSchema)(canonicalJson(decoded)));
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
};

/** Canonical UTC instant text for fingerprints and governed read output. */
export const isoInstant = (value: Date): string => DateTime.formatIso(DateTime.makeUnsafe(value));
export const optionalIsoInstant = (value: Date | null): string | null => (value === null ? null : isoInstant(value));
