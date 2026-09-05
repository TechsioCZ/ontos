// `*.config.ts` is ignored by default: bundler configs legitimately build local module-request sets.
import { builtinModules } from "node:module";

const nodeBuiltinRequests = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const seenEntries = new WeakSet<object>();
let externalCount = 0;

export default {
	externals: (request: string, entry: object): boolean => {
		seenEntries.add(entry);
		nodeBuiltinRequests.add(request);
		externalCount += 1;
		return nodeBuiltinRequests.has(request);
	},
	externalCount: () => externalCount,
};
