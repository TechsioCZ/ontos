// expect-count: 1
// B3/S1 evasion: one run *site* at the top level, but a fresh root fiber per iteration. This is the
// repeated deep re-entry S1 is about; it should be `Effect.forEach` inside a single program.
import { Effect } from "effect";

const ids = ["a", "b", "c"];

for (const id of ids) {
	await Effect.runPromise(Effect.succeed(id));
}
