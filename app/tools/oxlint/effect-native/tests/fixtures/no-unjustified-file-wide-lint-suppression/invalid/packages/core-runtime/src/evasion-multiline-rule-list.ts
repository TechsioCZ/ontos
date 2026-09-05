// expect-count: 1
/*
	oxlint-disable
	no-promise-executor-return,
	unicorn/no-await-expression-member
	--
	Bounded harness callbacks.
*/

export const noop = (): void => undefined;
