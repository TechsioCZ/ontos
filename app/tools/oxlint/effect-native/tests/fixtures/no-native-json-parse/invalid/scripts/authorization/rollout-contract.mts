// expect-count: 5
import { readFileSync } from "node:fs";

interface RolloutContract {
	readonly version: number;
}

// 1. the A7 shape: read a document, parse it untyped, validate it (maybe) later.
const contract: RolloutContract = JSON.parse(readFileSync("contract.json", "utf-8")) as RolloutContract;

// 2. point-free reference passed to a native collection API.
const events = readFileSync("events.ndjson", "utf-8").split("\n").map(JSON.parse);

// 3. aliased out of the global.
const parseJson = JSON.parse;

// 4. computed member access.
const overlay = JSON["parse"]('{"a":1}');

// 5. optional chaining.
const maybe = JSON?.parse?.("{}");

export { contract, events, parseJson, overlay, maybe };
