#!/usr/bin/env node
// A real script shape: hashbang + top-level await + .mts extension (no `expect-count` pin is
// possible because the hashbang must be line 1). One report expected, on line 4.
import { readFile } from "node:fs/promises";
const topology = JSON.parse(await readFile(process.argv[2] ?? "topology.json", "utf-8"));
export { topology };
