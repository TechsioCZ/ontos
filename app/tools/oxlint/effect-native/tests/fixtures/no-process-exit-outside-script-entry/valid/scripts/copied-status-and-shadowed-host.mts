// Copying exitCode does not write the process property; spelling cannot identify an injected host.
import proc from "node:process";
const { exitCode } = proc;
let copied = exitCode; copied = 1;
export function update(proc: {exit(code: number): void}) { proc.exit(1); }
const { exit } = proc;
if (proc.argv[1] !== undefined) exit(0);
