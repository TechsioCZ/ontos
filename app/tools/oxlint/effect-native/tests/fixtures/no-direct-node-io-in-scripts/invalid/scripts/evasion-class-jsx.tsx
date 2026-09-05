// expect-count: 4
// Evasion: nested arrow bodies, static class members, decorators, async generators and TSX all hide
// the same unscoped dependency.
import { createRequire } from "node:module";
import fs from "node:fs";

const req = createRequire(import.meta.url);

function logged<T>(value: T): T {
	return value;
}

@logged
export class Reporter {
	static readonly loadSpawn = async (): Promise<unknown> => (await import("node:child_process")).spawnSync;

	async *walk(root: string): AsyncGenerator<string> {
		const { readdir } = await import("node:fs/promises");
		for (const entry of await readdir(root)) yield entry;
	}

	render(target: string): JSX.Element {
		const childProcess = req("child_process") as { readonly execSync: (command: string) => Buffer };
		return (
			<pre data-source="node:fs">
				{fs.readFileSync(target, "utf-8")}
				{String(childProcess.execSync("git status"))}
			</pre>
		);
	}
}
