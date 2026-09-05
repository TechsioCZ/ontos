// Nothing here resolves to a node:fs / node:child_process import, so nothing may report.
import * as FileSystem from "effect/FileSystem";

// A parameter named like a Node I/O export.
export function render(fs: { readonly readFileSync: (path: string) => string }, target: string): string {
	return fs.readFileSync(target);
}

// A local helper named `readFile`.
const readFile = (target: string): string => `${target}:stub`;
export const stub = readFile("module.ts");

// A local `require` that is not CommonJS `require`.
const require = (specifier: string): string => specifier;
export const fake = require("node:fs");

// A local `spawnSync` object with the same member names.
const spawnSync = { call: (command: string) => command };
export const spawned = spawnSync.call("psql");

export const service = FileSystem.FileSystem;
