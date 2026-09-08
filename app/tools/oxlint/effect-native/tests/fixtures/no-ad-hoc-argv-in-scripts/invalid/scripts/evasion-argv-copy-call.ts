// Evasion: hand argv to an array/set constructor. `scripts/setup-agent-reference-repos.mts` writes
// `new Set(process.argv.slice(2))` (reported); dropping the `.slice(2)` evades the rule entirely.
const flags = new Set(process.argv);
const dryRun = flags.has("--dry-run");

const listed = Array.from(process.argv);
const mode = listed[2];

export { dryRun, mode };
