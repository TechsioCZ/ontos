// expect-count: 2
/** Point-free references to the Date methods, invoked later. */
export function encode(createdAt: Date): readonly [string, number] {
	const format = createdAt.toISOString;
	const readMillis = createdAt.getTime.bind(createdAt);
	return [format.call(createdAt), readMillis()];
}
