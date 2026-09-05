// expect-count: 3
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';

export const failed = (failure: Option.Option<unknown>, exit: Exit.Exit<number>) =>
	failure?._tag === 'Some' && exit._tag !== 'Success' && failure._tag != 'None';
