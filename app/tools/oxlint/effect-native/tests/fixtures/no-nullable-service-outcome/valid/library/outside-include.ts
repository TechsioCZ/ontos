export interface Row {
	readonly rowId: string;
}

/** Outside `include` (apps/verticals/packages/scripts): never reported. */
export interface OutOfScopePort {
	readonly load: () => Promise<Row | undefined>;
}
