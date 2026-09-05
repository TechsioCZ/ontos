// expect-count: 3
import { Schema } from "effect";

export interface DeploymentRow {
	readonly id: string;
}
export interface ModuleRow {
	readonly id: string;
}
export interface TenantRow {
	readonly id: string;
}

// computed member access on the Schema namespace.
export const DeploymentRowSchema = Schema["Struct"]({ id: Schema.String }) satisfies Schema.Codec<DeploymentRow>;

// double assertion still lands the prior interface on the Schema.
export const ModuleRowSchema = Schema.Struct({ id: Schema.String }) as unknown as Schema.Codec<ModuleRow>;

// annotation + `satisfies` on one declarator must report exactly once.
export const TenantRowSchema: Schema.Codec<TenantRow> = Schema.Struct({
	id: Schema.String,
}) satisfies Schema.Codec<TenantRow>;
