// expect-count: 3
import { Effect } from "effect";
import { createInterface } from "node:readline/promises";

const lines = createInterface({ input: process.stdin });

for await (const line of lines) {
	console.log(line);
}

const handle = await import("node:fs/promises");

for await (const entry of handle.opendir(".")) {
	console.log(entry.name);
}

void Effect.void;
