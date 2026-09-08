// Import spelling is not binding identity; injected hosts and entry-path aliases remain legal.
import proc from "node:process";
import util from "node:util";
export function fake(proc: {argv: string[]}, util: {parseArgs(): void}) { proc.argv[2]; util.parseArgs(); }
const { argv: args } = proc;
export const entry = args[`1`];
