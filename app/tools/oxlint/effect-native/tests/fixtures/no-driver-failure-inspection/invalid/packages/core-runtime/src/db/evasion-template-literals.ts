// EVASION: a zero-expression template literal is not a `Literal` node, so backtick strings defeat
// detection axes 1 (`in` narrowing), 3 (SQLSTATE), 4 (socket code), 6 (class prefix) and the
// computed `.cause` read all at once. Fix: treat a TemplateLiteral with no expressions as its string.
export const classify = (error: Record<string, unknown>): string => {
	if (`code` in error && error.code === `23505`) return 'conflict';
	if (error.code === `ECONNREFUSED`) return 'unavailable';
	if (String(error.code).startsWith(`08`)) return 'connectivity';
	return String(error[`cause`] ?? 'unknown');
};
