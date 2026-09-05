// expect-count: 4
// Mirrors the A7 evidence site: an authoritative installed-MicroVertical topology decoded as
// shape-free JSON and then walked by hand with exact-key comparisons and `throw new TypeError`.
import { Effect, Predicate, Schema } from 'effect';

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

declare const ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: JsonValue;

const object = (value: JsonValue) => {
  if (!Predicate.isObjectKeyword(value) || value === null || Array.isArray(value)) {
    throw new TypeError('expected object');
  }
  return Schema.decodeUnknownSync(JsonObjectSchema)(value);
};

export const deriveInstalledVerticalIds = (input: JsonValue): Effect.Effect<readonly string[]> =>
  Effect.sync(() => Object.keys(object(input)));

export const ambientTopology = Schema.decodeUnknownSync(Schema.Json)(
  ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY,
);
