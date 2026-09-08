// expect-count: 5
import "node:fs";
import { createRequire } from "node:module";
import { type Stats, readdirSync } from "node:fs";

export * from "node:fs/promises";

const localRequire = createRequire(import.meta.url);
const childProcess = localRequire("node:child_process");

export async function inspect(directory: string): Promise<readonly string[]> {
	const promises = await import(`node:fs`);
	const stats: Stats = await promises.stat(directory);
	childProcess.execFileSync("ls", [directory]);
	return stats.isDirectory() ? readdirSync(directory) : [];
}
