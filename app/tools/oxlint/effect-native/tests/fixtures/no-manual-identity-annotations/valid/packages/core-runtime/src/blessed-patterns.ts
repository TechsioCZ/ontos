// Patterns the audit explicitly preserves must stay silent under this rule.
import { Effect, Exit, Layer, Schema } from 'effect';

declare const runtimeLayer: Layer.Layer<never, Error>;
declare const rows: ReadonlyArray<{ correlationId: string; tenantId: string }>;
declare const exit: Exit.Exit<number, Error>;

// Layer.orDie at the deliberate startup root, typed cause logged first.
export const startup = runtimeLayer.pipe(
	Layer.tapErrorCause((cause) => Effect.logError('Startup layer failed', cause)),
	Layer.orDie,
);

// Drizzle JSONB / HttpApi serialization owned by Schema, not by hand.
export const OutboxPayload = Schema.Struct({ correlationId: Schema.String, payload: Schema.Json });

// Native array operations where Effect collection APIs add no semantic value.
export const tenantIds = rows.map((row) => row.tenantId).filter((id) => id.length > 0);

// Bare Effect.runPromise at the single outer process seam.
export const outcome = Exit.isSuccess(exit) ? exit.value : 0;

// A span with no attributes, and a log span label.
export const traced = Effect.void.pipe(
	Effect.withSpan('Contacts.ARES.subject'),
	Effect.withLogSpan('ares'),
);
