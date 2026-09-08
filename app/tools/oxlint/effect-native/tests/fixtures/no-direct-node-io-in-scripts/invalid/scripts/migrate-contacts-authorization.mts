// expect-count: 4
// B3 evidence shape: a migration script that owns the filesystem and child processes itself.
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { execa } from "execa";

export async function migrate(source: string, target: string): Promise<void> {
	const raw = fs.readFileSync(source, "utf-8");
	const decoded = await readFile(source, "utf-8");
	await writeFile(target, `${raw}${decoded}`, "utf-8");
	spawnSync("psql", ["-f", target], { stdio: "inherit" });
	await execa("psql", ["-c", "select 1"]);
}
