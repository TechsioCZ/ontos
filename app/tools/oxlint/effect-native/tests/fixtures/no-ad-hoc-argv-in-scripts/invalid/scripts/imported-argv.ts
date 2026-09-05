// expect-count: 4
import { argv as processArgv } from "node:process";
import nodeProcess from "node:process";
import * as processNamespace from "process";

const forwarded = processArgv.slice(2);
const mode = nodeProcess.argv[2];
const filtered = processNamespace.argv.filter((argument) => argument !== "--");
const [, , subcommand] = processArgv;

export { filtered, forwarded, mode, subcommand };
