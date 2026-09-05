// expect-count: 4
import { Effect as E } from "effect";
import * as EffectNs from "effect/Effect";

declare const program: E.Effect<string>;
declare const test: (name: string, body: () => Promise<void>) => void;

test("aliased namespace", async () => {
	await E.runPromise(program);
	await E["runPromise"](program);
	await EffectNs.runPromise(program);
	EffectNs.runSync(program);
});
