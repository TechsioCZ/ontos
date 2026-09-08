// B3/A6: `labels.forEach(console.info)` is reported as `consoleReference`; the identical callback
// through a `node:console` named import must be too, and so must capturing it into a variable.
import { log } from "node:console";
import { warn as printWarn } from "node:console";

export const emit = (lines: readonly string[]): void => {
	lines.forEach(log);
};

export const captured = printWarn;
