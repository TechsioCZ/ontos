// expect-count: 2
import { Cause, Exit } from './local-effectish.ts';

export const show = (error: Record<string, unknown>): string =>
	Cause.pretty(error.cause) + Exit.match(error.cause);
