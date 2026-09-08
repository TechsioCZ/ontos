// expect-count: 2
import fs = require("node:fs");

const childProcess = require("child_process");

export function run(command: string, target: string): string {
	childProcess.execSync(command);
	return fs.readFileSync(target, "utf-8");
}
