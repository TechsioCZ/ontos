// expect-count: 2
import fs from "node:fs";
import { spawnSync } from "node:child_process";

export function Report({ path }: { readonly path: string }): JSX.Element {
	spawnSync("git", ["status"], { stdio: "ignore" });
	return <pre>{fs.readFileSync(path, "utf-8")}</pre>;
}
