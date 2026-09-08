// expect-count: 2
import { Function as Fn, pipe as flow, Schema } from "effect";

export interface ShellResource {
	readonly id: string;
}
export interface ShellModule {
	readonly moduleId: string;
}

// `Function.pipe(...)` point-free construction.
export const ShellResourceSchema = Fn.pipe(
	Schema.Struct({ id: Schema.String }),
	Schema.annotate({ title: "resource" }),
) satisfies Schema.Codec<ShellResource>;

// aliased `pipe` import.
export const ShellModuleSchema = flow(
	Schema.Struct({ moduleId: Schema.String }),
	Schema.annotate({ title: "module" }),
) satisfies Schema.Codec<ShellModule>;
