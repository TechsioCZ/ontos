// Evasion: `require("yargs")` is reported, but scripts are ESM (.mts/.mjs) where the realistic
// escape hatch is createRequire.
import { createRequire } from "node:module";

const requireFrom = createRequire(import.meta.url);
const yargs = requireFrom("yargs");

export { yargs };
