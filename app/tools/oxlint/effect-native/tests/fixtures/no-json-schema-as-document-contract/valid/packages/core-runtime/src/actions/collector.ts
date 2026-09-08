// Allowlisted path: the action audit-evidence envelope is deliberately shape-free.
import { Effect, Schema } from 'effect';

export type JsonValue = Schema.Schema.Type<typeof Schema.Json>;
export const EvidenceSchema = Schema.Record(Schema.String, Schema.Json);

export const collect = (declared: unknown): Effect.Effect<JsonValue, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(Schema.Json)(declared);
