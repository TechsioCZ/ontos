import { Exit } from 'effect';

/** Stress the wrapper-unwrapping loop; `Completed` is not an Effect ADT tag. */
export const deep = (exit: Exit.Exit<void>): boolean =>
	((((((((((((((((((((exit as Exit.Exit<void>))))))))))))))))))))._tag === 'Completed';

export const alsoDeep = (exit: Exit.Exit<void>): boolean =>
	(((exit satisfies Exit.Exit<void>) as Exit.Exit<void>)!)._tag === 'Pending';
