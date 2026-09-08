import { Schema } from "effect";
import * as LocalSchema from "./local-schema.ts";

export interface Row {
	readonly id: string;
}

// A same-named `Codec` from a module that is not `effect`.
export const localRow: LocalSchema.Codec<Row> = LocalSchema.Struct({ id: LocalSchema.String });

// Indexed access: the declarator's own type is the decoded value, not a codec.
export const rowValue: Schema.Codec<Row>["Type"] = { id: "r_1" };

// Widening / erasure spellings the rule deliberately allows.
export const anyCodec: Schema.Codec = Schema.String;
export const neverCodec: Schema.Codec<never> = Schema.Never;

// Derived type arguments keep the Schema as the sole authority.
export const RowSchema = Schema.Struct({ id: Schema.String });
export const RowAlias: Schema.Codec<typeof RowSchema.Type, typeof RowSchema.Encoded> = RowSchema;
export const RowDerived: Schema.Codec<ReturnType<typeof makeRow>> = RowSchema;

function makeRow(): Row {
	return { id: "r_1" };
}
