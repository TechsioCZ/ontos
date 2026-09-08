// expect-count: 3
// Module-level `for await` buried in blocks, labels and try statements.
import { Effect } from "effect";

declare const source: AsyncIterable<number>;
declare const cond: boolean;

try {
	for await (const value of source) console.log(value);
} finally {
	console.log("done");
}

outer: {
	if (cond) break outer;
	for await (const value of source) console.log(value);
}

{
	for await (const value of source) console.log(value);
}

void Effect.void;
