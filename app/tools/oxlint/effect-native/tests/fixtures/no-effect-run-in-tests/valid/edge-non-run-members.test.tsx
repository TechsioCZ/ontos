// `runtime` is not a `run*` entry point, a Schema namespace is not Effect, and a plain client
// object with a `runPromise` method is not the effect import.
import { Effect, Layer, ManagedRuntime } from "effect";
import * as Schema from "effect/Schema";

declare const AppLayer: Layer.Layer<never>;
declare const program: Effect.Effect<string>;
declare const client: { runPromise: (p: unknown) => Promise<unknown> };

export const composed = Effect.provide(Effect.scoped(program), AppLayer);
export const runtimeRef = Effect.runtime;
export const decoded = Schema.decodeUnknownSync(Schema.String);
export const viaManagedRuntime = ManagedRuntime.make(AppLayer).runPromise(program);
export const viaClient = client.runPromise(program);

export function Panel(): JSX.Element {
	return <span>{String(composed)}</span>;
}
