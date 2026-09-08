// expect-count: 4
import * as Effect from "effect";
import { pipe } from "effect";

export interface OutboxRow {
	readonly id: string;
}
export interface PrincipalRecord {
	readonly principalId: string;
}
export interface ModuleDescriptor {
	readonly moduleId: string;
}
export interface DeploymentRef {
	readonly deploymentId: string;
}

// root barrel access: `import * as Effect from "effect"` then `Effect.Schema.Codec`.
export const OutboxRowSchema: Effect.Schema.Codec<OutboxRow> = Effect.Schema.Struct({
	id: Effect.Schema.String,
});

// point-free `pipe(schema, ...)` initializer.
export const PrincipalRecordSchema: Effect.Schema.Codec<PrincipalRecord> = pipe(
	Effect.Schema.Struct({ principalId: Effect.Schema.String }),
	Effect.Schema.annotate({ title: "principal" }),
);

// `satisfies` re-assertion of a prior interface.
export const ModuleDescriptorSchema = Effect.Schema.Struct({
	moduleId: Effect.Schema.String,
}) satisfies Effect.Schema.Codec<ModuleDescriptor>;

// `as` cast onto a prior interface.
export const DeploymentRefSchema = Effect.Schema.Struct({
	deploymentId: Effect.Schema.String,
}) as Effect.Schema.Codec<DeploymentRef>;

export const Badge = (): JSX.Element => <span>{String(OutboxRowSchema)}</span>;
