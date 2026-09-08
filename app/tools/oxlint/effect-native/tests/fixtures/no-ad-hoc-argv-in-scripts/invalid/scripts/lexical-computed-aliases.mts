// expect-count: 2
import * as proc from "node:process";
const host = proc;
const { argv: args } = host;
export const mode = host["argv" as string][2];
export const flag = args[`3`];
