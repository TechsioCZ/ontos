// expect-count: 4
// Evasion: the dependency is re-exported instead of used locally — the script still loads it.
export * as filesystem from "node:fs";
export { default as fsDefault } from "node:fs";
export { execSync as runCommand } from "child_process";
export { copy } from "fs-extra/lib/copy";
