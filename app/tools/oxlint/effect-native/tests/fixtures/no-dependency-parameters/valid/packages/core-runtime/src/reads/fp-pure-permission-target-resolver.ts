import { Effect, Schema } from "effect";

// Reduced from packages/core-runtime/src/reads/definition.ts:50-56,164-166.
// `ReadPermissionTargetResolver` is a *pure, per-read* mapping supplied at the definition site
// (`defineRead(descriptor, handler, serviceFactory, permissionTargetResolver)`); it returns a plain
// value, never an Effect, and is parameterised by that read's own input type. It is declarative
// definition data, not a dependency that could ever be resolved with `yield* …` from a Layer.
// The rule reports it purely because its name ends in `Resolver`.
export type ResolvedReadPermissionTarget =
	| { readonly kind: "legal_entity" }
	| { readonly kind: "module"; readonly moduleId: string };

export type OperationalScope = { readonly tenantId: string };

export type ReadPermissionTargetResolver<Input> = (
	input: Input,
	scope: OperationalScope,
) => ResolvedReadPermissionTarget;

export type ReadResultPermissionTargetResolver<Result> = (
	result: Result,
	scope: OperationalScope,
) => readonly string[];

export declare const defineRead: <Input, Result>(
	handler: (input: Input) => Effect.Effect<Result>,
	permissionTargetResolver: ReadPermissionTargetResolver<Input>,
	resultPermissionTargetResolver?: ReadResultPermissionTargetResolver<Result>,
) => Schema.Schema<Result>;
