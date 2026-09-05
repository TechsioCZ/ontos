// expect-count: 3
import { parseArgs } from "node:util";
import util from "node:util";

const parsed = parseArgs({ options: { fix: { type: "boolean" } } });
const alsoParsed = util.parseArgs({ options: {} });
const forwarded = process.argv.slice(2);

export { alsoParsed, forwarded, parsed };
