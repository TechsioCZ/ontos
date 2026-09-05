import { Schema } from "effect";

export const RowSchema = Schema.Struct({ id: Schema.String });
export type Row = typeof RowSchema.Type;

// A local value that shadows the `Schema` import inside a nested scope.
export function build(): unknown {
	const Struct = (fields: Record<string, unknown>): unknown => fields;
	return Struct({ id: "x" });
}
