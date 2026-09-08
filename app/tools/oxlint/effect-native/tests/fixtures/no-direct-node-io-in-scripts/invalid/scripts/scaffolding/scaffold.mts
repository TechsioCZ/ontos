// expect-count: 4
// A8: the generator's own dependencies report; the code it *emits* is a string and does not.
import * as fs from "node:fs";
import { mkdirSync } from "fs";
import { spawn } from "child_process";

const EMITTED_MODULE = `import fs from "node:fs";
import { spawnSync } from "node:child_process";
export const read = (p: string) => fs.readFileSync(p, "utf-8");
`;

export async function scaffold(directory: string): Promise<string> {
	mkdirSync(directory, { recursive: true });
	fs.writeFileSync(`${directory}/module.ts`, EMITTED_MODULE);
	const { readFile } = await import("node:fs/promises");
	spawn("pnpm", ["install"], { cwd: directory });
	return readFile(`${directory}/module.ts`, "utf-8");
}
