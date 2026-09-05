// expect-count: 3
import * as Cause from './local-cause.ts';

export const inspect = (error: Record<string, unknown>): boolean =>
	Cause.hasDies(error.cause) || 'sqlState' in error || error?.['cause'] === undefined;
