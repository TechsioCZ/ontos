// The B3 target shape: services yielded from the environment, plus every allowed lexical edge case.
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Type-only imports are erased: they open no handle and own no resource.
import type { Dirent } from "node:fs";
import { type BigIntStats } from "node:fs";
export type { Stats } from "node:fs";

// Pure, lifecycle-free builtins are deliberately out of `modules`.
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// A8: a generator emitting `node:fs` *text* is a string, not a dependency.
const EMITTED = `import fs from "node:fs";
const { spawnSync } = require("node:child_process");
`;

export const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const filePath = yield* Path.Path;
	const root = filePath.join(os.tmpdir(), "ontos");
	const entries = yield* fs.readDirectory(root);
	const contents = yield* fs.readFileString(filePath.join(root, "module.ts"));
	const stats: BigIntStats | undefined = undefined;
	return { contents, entries, here: fileURLToPath(import.meta.url), sep: path.sep, stats, EMITTED };
});

export function describe(entry: Dirent): string {
	return entry.name;
}

// A dynamic import of something that is not Node I/O.
export const helpers = await import("./shared.mts");
