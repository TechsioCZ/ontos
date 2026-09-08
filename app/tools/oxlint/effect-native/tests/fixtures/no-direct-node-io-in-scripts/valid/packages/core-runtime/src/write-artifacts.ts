// Outside `scripts/**`: this rule enforces B3, which is about operational scripts only.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

export function writeArtifact(target: string, contents: string): void {
	fs.writeFileSync(target, contents, "utf-8");
	spawnSync("git", ["add", target], { stdio: "ignore" });
}
