// Test files are out of scope: B2 owns the Effect test harness, not B3.
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

export async function fixture(target: string): Promise<string> {
	spawnSync("git", ["status"], { stdio: "ignore" });
	fs.mkdirSync(target, { recursive: true });
	return readFile(target, "utf-8");
}
