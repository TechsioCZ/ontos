// expect-count: 1
// Computed access with a substitution-free template literal is the same static member as
// `Effect["runPromise"]`, which the rule already reports.
import { Effect } from "effect";

declare const program: Effect.Effect<string>;
declare const it: (name: string, body: () => Promise<void>) => void;

it("runs through a template key", async () => {
	await Effect[`runPromise`](program);
});
