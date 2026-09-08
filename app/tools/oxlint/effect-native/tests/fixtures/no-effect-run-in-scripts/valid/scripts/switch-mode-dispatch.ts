// CLI mode dispatch (`prepare | verify | finalize`, as in scripts/migrate-contacts-authorization.mts):
// three syntactic run sites, but exactly one root fiber ever starts, and all of them are at the edge.
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

declare const prepare: Effect.Effect<void>;
declare const verify: Effect.Effect<void>;
declare const finalize: Effect.Effect<void>;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	switch (process.argv[2]) {
		case "prepare": {
			await Effect.runPromise(prepare);
			break;
		}
		case "verify": {
			await Effect.runPromise(verify);
			break;
		}
		default: {
			await Effect.runPromise(finalize);
		}
	}
}
