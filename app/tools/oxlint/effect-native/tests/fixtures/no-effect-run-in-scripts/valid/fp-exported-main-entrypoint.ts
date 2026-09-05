// False-positive guard: a Program-level `main` that IS the executable edge but is re-exported
// with an export specifier (or `export default`) for its test file. Only the export syntax
// differs from valid/scripts/main-invoked-from-guard.ts, yet the single blessed run site is
// reported as `nestedRun` because `export { main }` / `export default main` add a variable
// reference that is not a CallExpression callee, so isOnlyCalledFromTopLevel() gives up.
// Audit "Existing patterns to preserve": one bare run at the single outer process seam is fine.
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

declare const program: Effect.Effect<void>;

const main = async (): Promise<void> => {
	await Effect.runPromise(program);
};

export { main };

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
