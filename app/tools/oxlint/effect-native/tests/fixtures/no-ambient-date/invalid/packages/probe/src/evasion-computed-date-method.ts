// expect-count: 2
/** Computed member access is the same hand serialisation / hand arithmetic. */
interface Row {
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export function encode(row: Row): readonly [string, number] {
	return [row.createdAt["toISOString"](), row.updatedAt["getTime"]()];
}
