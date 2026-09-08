// expect-count: 2
// Policy boundary: oxlint.config.ts allows successful operational output; audit B3/A6 targets diagnostic logging.
import nodeConsole from "node:console";
import { error as printError } from "node:console";
import { stdout } from "node:process";

export function emit(planJson: string, message: string): void {
	process.stdout.write(`${planJson}\n`);
	process.stderr.write(`${message}\n`);
	stdout.write("raw plan bytes\n");
	nodeConsole.log(message);
	printError(message);
}
