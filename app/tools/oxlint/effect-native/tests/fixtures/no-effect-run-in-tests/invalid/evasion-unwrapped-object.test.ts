// expect-count: 3
// A type assertion around the namespace is erased at build time; the call is still a root fiber.
import { Effect } from "effect";

declare const program: Effect.Effect<string>;
declare const it: (name: string, body: () => Promise<void>) => void;

it("runs through assertions", async () => {
	await Effect!.runPromise(program);
	await (Effect as typeof Effect).runPromise(program);
	await (Effect satisfies typeof Effect).runPromise(program);
});
