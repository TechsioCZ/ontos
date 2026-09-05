// expect-count: 2
import * as Schemas from "effect/Schema";
import type { Codec as SchemaCodec, Schema as SchemaOf } from "effect/Schema";

export interface OutboxRow {
	readonly id: string;
}
export interface PrincipalRow {
	readonly principalId: string;
}

// Aliased direct type import of the codec type itself: still `effect/Schema`'s `Codec`.
export const outboxRowSchema: SchemaCodec<OutboxRow> = Schemas.Struct({ id: Schemas.String });

// Aliased direct type import of `Schema<A, I>`.
export const principalRowSchema: SchemaOf<PrincipalRow, unknown> = Schemas.Struct({
	principalId: Schemas.String,
});
