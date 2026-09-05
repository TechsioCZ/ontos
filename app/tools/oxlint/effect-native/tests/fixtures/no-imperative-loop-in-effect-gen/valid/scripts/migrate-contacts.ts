// `scripts/` is out of scope by default (`includeScripts: false`): audit B3 owns script migration.
import { Effect } from "effect";

declare const rows: readonly string[];
declare const migrate: (row: string) => Effect.Effect<void>;

export const program = Effect.gen(function* () {
	let migrated = 0;
	for (const row of rows) {
		yield* migrate(row);
		migrated += 1;
	}
	return migrated;
});
