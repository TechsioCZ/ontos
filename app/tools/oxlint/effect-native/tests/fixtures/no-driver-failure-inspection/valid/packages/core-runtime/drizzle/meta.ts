export const isUnique = (error: Record<string, unknown>): boolean =>
	'code' in error && error.code === '23505' && 'cause' in error && error.cause !== undefined;
