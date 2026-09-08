// Test file: deliberately malformed documents proving rejection are D-tier, and the audit blesses
// tests that decode through Schema.
import { Schema } from 'effect';

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

export const decodeMalformed = (raw: unknown): JsonValue =>
  Schema.decodeUnknownSync(JsonObjectSchema)(raw);

export const decodeAnything = Schema.decodeUnknownSync(Schema.Json);
