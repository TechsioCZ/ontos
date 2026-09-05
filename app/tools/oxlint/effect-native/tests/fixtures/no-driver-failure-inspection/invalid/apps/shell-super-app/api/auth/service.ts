// expect-count: 8
export const isDatabaseUnavailable = (error: Record<string, unknown>, depth = 0): boolean => {
	if (depth > 3) {
		return false;
	}
	if ('code' in error) {
		const code = String(error.code);
		if (
			/^(?:08|40|53|55|57|58)/u.test(code) ||
			code === 'ECONNREFUSED' ||
			code === 'ECONNRESET' ||
			code === 'EPIPE' ||
			code === 'ETIMEDOUT'
		) {
			return true;
		}
	}
	return 'cause' in error && isDatabaseUnavailable(error.cause as Record<string, unknown>, depth + 1);
};
