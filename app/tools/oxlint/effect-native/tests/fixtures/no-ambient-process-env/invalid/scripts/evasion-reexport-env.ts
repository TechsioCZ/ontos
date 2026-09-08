// expect-count: 2
// A3: re-exporting the environment bag is the import form turned inside out — every consumer
// of this module reads the real environment while no `process.env` token appears at the call site.
export { env } from "node:process";
export { env as ambient } from "process";
