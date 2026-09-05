// Every pattern the audit explicitly blesses ("Existing patterns to preserve" and D tier).
import { Effect, Layer, Schema } from "effect";

const DatabaseLive = Layer.succeed({} as never, {} as never);

// D tier: `Layer.orDie` at a deliberate outer startup boundary, after the typed cause is logged.
export const RootLayer = DatabaseLive.pipe(
	Layer.tapErrorCause((cause) => Effect.logError("startup failed", cause)),
	Layer.orDie,
);

// "Existing patterns to preserve": bare `Effect.runPromise` at the single outer process seam.
export const main = (): Promise<void> =>
	Effect.runPromise(Effect.logInfo("shell started").pipe(Effect.provide(RootLayer)));

// C1: correct Drizzle JSONB / HttpApi serialization is explicitly not to be replaced.
export const OutboxPayload = Schema.Struct({ kind: Schema.String, body: Schema.Unknown });
export const encodePayload = Schema.encodeUnknownSync(OutboxPayload);

// D tier: native array/object operations where Effect collection APIs add no semantic value.
export const moduleIds = (rows: readonly { readonly id: string }[]): readonly string[] =>
	rows.map((row) => row.id).filter((id) => id.length > 0);
