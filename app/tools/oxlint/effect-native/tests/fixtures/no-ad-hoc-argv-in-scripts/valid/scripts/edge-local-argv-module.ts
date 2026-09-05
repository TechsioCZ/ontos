// `argv` and `parseArgs` imported from a local module are not node:process / node:util.
import { argv } from "./argv-fixture.ts";
import { parseArgs } from "./local-parse-args.ts";

const flags = argv.slice(2);
const parsed = parseArgs({ options: {} });

export { flags, parsed };
