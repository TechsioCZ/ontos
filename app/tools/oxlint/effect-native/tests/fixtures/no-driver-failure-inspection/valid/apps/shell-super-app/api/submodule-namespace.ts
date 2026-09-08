import * as Cause from 'effect/Cause';

export const render = (permissionTargetExit: { readonly cause: Cause.Cause<unknown> }): string =>
	Cause.pretty(permissionTargetExit.cause);
