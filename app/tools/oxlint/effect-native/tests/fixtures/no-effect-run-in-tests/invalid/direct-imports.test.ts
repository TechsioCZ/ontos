// expect-count: 2
import { runPromise, runSyncExit } from "effect/Effect";
import type { Effect } from "effect/Effect";

declare const program: Effect<string>;
declare const it: (name: string, body: () => Promise<void>) => void;

it("imports run functions directly", async () => {
	await runPromise(program);
	runSyncExit(program);
});
