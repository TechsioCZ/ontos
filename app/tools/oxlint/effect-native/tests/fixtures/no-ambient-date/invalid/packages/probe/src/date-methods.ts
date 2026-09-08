// expect-count: 6
/** Hand serialisation and hand calendar arithmetic on Drizzle rows. */
interface Row {
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export function encode(row: Row): Record<string, unknown> {
	const start = row.createdAt.getTime();
	const day = row.createdAt.getDate();
	const year = row.updatedAt.getFullYear();
	const offset = row.updatedAt.getTimezoneOffset();
	const copy = row.updatedAt;
	copy.setHours(0);
	return { createdAt: row.createdAt.toISOString(), start, day, year, offset };
}
