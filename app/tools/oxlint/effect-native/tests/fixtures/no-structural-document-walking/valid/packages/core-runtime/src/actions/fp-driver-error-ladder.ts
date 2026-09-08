import { Predicate } from 'effect';

/**
 * False positive reproduction — `packages/core-runtime/src/actions/runtime.ts:247`.
 *
 * One raw driver-error classification ladder. `no-driver-failure-inspection` already reports the rest
 * of it (`'code' in error`, the SQLSTATE literals, the `.cause` walk), and this rule deliberately
 * exempts that vocabulary through `allowInKeys` "so one span never earns two diagnostics" — but the
 * ladder's first arm, `'commitIndeterminate' in error`, is claimed here anyway, with the wrong remedy
 * (a `Schema.Struct` with `onExcessProperty: 'error'` for a pg driver error object).
 */
export const isCommitAcknowledgementFailure = (error: unknown): boolean => {
	if (!Predicate.isObjectKeyword(error) || error === null) return false;
	if ('commitIndeterminate' in error && error.commitIndeterminate === true) return true;
	return 'code' in error && Predicate.isString(error.code);
};
