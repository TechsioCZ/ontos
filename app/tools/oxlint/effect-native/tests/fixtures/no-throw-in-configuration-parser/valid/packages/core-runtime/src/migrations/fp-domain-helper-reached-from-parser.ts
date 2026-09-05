/**
 * Regression: `followLocalHelpers` must not turn an unrelated domain helper into a
 * "configuration helper" just because the module's entrypoint happens to read the
 * environment.
 *
 * Shape copied verbatim from `verticals/contacts/scripts/prepare-contacts-migration.mts`
 * (only masked in the real tree because a nested `scripts/` directory is normalised away).
 *
 * `classifyJournalState` reads no environment value, takes no environment record, is
 * exported, and is exercised directly by tests. Its throw reports an ambiguous *database*
 * migration journal — a data-integrity failure, not a missing or malformed configuration
 * value — so audit A3 does not own it and no `Config`/`ConfigError` restatement exists.
 * `main` itself never throws, so nothing here is a configuration throw.
 */
interface JournalRow {
	readonly contacts: boolean;
	readonly legacy: boolean;
}

export type JournalState = "ambiguous" | "contacts" | "fresh" | "legacy";

export const classifyJournalState = (row: JournalRow | undefined): JournalState => {
	if (row === undefined) {
		return "fresh";
	}
	if (row.legacy && row.contacts) {
		// Database state, not configuration: two migration journals exist at once.
		throw new Error("Ambiguous migration state: both CRM and Contacts journals exist");
	}
	return row.legacy ? "legacy" : "contacts";
};

export const main = (rows: readonly JournalRow[]): JournalState | undefined => {
	const connectionString = process.env["DATABASE_ADMIN_URL"]?.trim();
	if (connectionString === undefined || connectionString.length === 0) {
		return undefined;
	}
	return classifyJournalState(rows[0]);
};
