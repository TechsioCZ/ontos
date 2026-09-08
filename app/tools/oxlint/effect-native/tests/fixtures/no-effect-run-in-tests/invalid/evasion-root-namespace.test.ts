// expect-count: 2
// `effect`'s root barrel is `export * as Effect from "./Effect.ts"`, so a root namespace import
// reaches the very same run functions through a two-level member expression.
import * as EffectLib from "effect";

declare const program: EffectLib.Effect.Effect<string>;
declare const it: (name: string, body: () => Promise<void>) => void;

it("runs through the root namespace", async () => {
	await EffectLib.Effect.runPromise(program);
	EffectLib.Effect.runSync(program);
});
