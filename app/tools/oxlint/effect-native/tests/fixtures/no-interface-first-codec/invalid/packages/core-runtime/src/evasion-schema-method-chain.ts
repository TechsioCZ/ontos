// expect-count: 2
import { Schema } from "effect";

export interface OutboxEnvelope {
	readonly id: string;
}
export interface OutboxCursor {
	readonly at: string;
}

// Effect v4 Schema instance methods (`.annotate` / `.check`) instead of `.pipe`.
export const OutboxEnvelopeSchema = Schema.Struct({ id: Schema.String }).annotate({
	title: "envelope",
}) satisfies Schema.Codec<OutboxEnvelope>;

export const OutboxCursorSchema = Schema.Struct({ at: Schema.String }).check(
	Schema.isoDateString,
) as Schema.Codec<OutboxCursor>;
