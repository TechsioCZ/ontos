// EVASION: destructuring reads `.cause` without a MemberExpression, so the cause-chain walk in
// axis 2 is invisible. Fix: match an ObjectPattern with a `cause` key whose init is not
// exit-named / not a cause sink.
export const unwrapDriverFailure = (error: { readonly cause?: unknown }): unknown => {
	const { cause } = error;
	const { cause: nested } = (cause ?? {}) as { readonly cause?: unknown };
	return nested;
};
