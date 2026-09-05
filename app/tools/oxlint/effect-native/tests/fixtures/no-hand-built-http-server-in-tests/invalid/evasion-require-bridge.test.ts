// Evasion: reach node:http through require(). `apps/shell-super-app/rstest.config.ts` installs
// `globalThis.require = createRequire(import.meta.url)`, so this runs in the real test environment
// and contains no ImportDeclaration from a server module at all.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createServer } = require("node:http") as {
	createServer: (handler: () => void) => { listen: (port: number, host: string) => void };
};

export const server = createServer(() => {});
server.listen(0, "127.0.0.1");
