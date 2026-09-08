// Point-free `pipe` with the schema as the pipe *subject* rather than the codec argument.
import { pipe, Schema } from 'effect';

export const decodeTopology = pipe(Schema.Json, Schema.decodeUnknownSync);
export const decodeAllowlist = pipe(
  Schema.Record(Schema.String, Schema.Json),
  Schema.decodeUnknownEffect,
);
