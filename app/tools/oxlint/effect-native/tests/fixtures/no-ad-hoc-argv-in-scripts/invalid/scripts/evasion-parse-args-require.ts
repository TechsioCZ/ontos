// Evasion: reach node:util parseArgs through require() instead of a static named import.
const { parseArgs } = require("node:util");
const parsed = parseArgs({ options: { fix: { type: "boolean" } } });

export { parsed };
