// expect-count: 3
// Evasion: the module specifier hides behind a type-level wrapper the rule already knows how to
// unwrap everywhere else (`unwrap`/`TRANSPARENT_TYPES`), but does not apply to import()/require().
import { createRequire } from "node:module";

const localRequire = createRequire(import.meta.url);

export async function load(): Promise<readonly unknown[]> {
	const fsModule = await import("node:fs" as string);
	const childModule = await import("node:child_process" satisfies string);
	const promisesModule = localRequire("node:fs/promises" as const);
	return [fsModule, childModule, promisesModule];
}
