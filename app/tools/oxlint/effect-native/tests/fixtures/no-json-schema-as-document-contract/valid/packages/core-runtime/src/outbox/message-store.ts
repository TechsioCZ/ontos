// Allowlisted path: `packages/core-runtime/src/outbox/**` genuinely owns an opaque payload.
import { Schema } from 'effect';

export const OutboxPayload = Schema.Record(Schema.String, Schema.Json);
export const decodeOutboxPayload = Schema.decodeUnknownEffect(Schema.Json);
export type OutboxPayloadValue = Schema.Schema.Type<typeof Schema.Json>;
