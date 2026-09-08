// "Existing patterns to preserve": Drizzle JSONB and HttpApi serialization hand over a value,
// never a hand-built JSON string, so they are invisible to this rule.
import { Schema } from "effect";

export const OutboxPayload = Schema.Struct({ kind: Schema.String, subjectId: Schema.String });

declare const outbox: unknown;
declare const db: {
	readonly insert: (table: unknown) => { readonly values: (row: unknown) => Promise<void> };
};

export const enqueue = async (payload: typeof OutboxPayload.Type): Promise<void> => {
	await db.insert(outbox).values({ payload });
};

export const handler = (payload: typeof OutboxPayload.Type) => ({ status: 201, body: payload });
