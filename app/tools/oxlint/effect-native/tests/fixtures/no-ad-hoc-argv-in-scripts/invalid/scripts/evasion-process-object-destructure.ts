// Evasion: destructure `argv` off the process object instead of writing `process.argv`.
// The rule already tracks `import { argv } from "node:process"`; this is the same binding by
// another route, and every downstream use is invisible to it.
const { argv } = process;
const forwarded = argv.slice(2);

const { argv: renamed = [] } = globalThis.process;
const mode = renamed[2];

export { forwarded, mode };
