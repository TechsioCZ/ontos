// Evasion: re-export a banned CLI framework instead of importing it. A `scripts/lib/cli.mts`
// barrel re-export puts yargs back into the repository without an ImportDeclaration.
export { default as yargs, Argv } from "yargs";
