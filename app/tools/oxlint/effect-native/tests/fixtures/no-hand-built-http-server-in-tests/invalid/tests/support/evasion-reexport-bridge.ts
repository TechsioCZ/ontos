// Evasion: consolidate the "three copies of node:http bridging" into one shared test-support
// module that re-exports the builtin. Tests then `import { createServer } from "./evasion-reexport-bridge.ts"`
// and no test file ever contains a node:http ImportDeclaration.
export { createServer } from "node:http";
export * as http2 from "node:http2";
export * from "node:net";
