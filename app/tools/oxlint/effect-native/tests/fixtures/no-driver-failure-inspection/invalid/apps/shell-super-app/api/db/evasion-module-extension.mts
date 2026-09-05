// expect-count: 3
export const unique = (error: Record<string, unknown>): boolean =>
	'code' in error && error.code === '23505' && error.cause !== undefined;
