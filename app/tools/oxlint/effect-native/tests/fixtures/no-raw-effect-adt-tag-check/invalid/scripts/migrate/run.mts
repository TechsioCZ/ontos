// expect-count: 2
import { Either, Exit } from 'effect';

export const report = (parsed: Either.Either<string, Error>, exit: Exit.Exit<void>): string => {
	if (parsed._tag === 'Left') return 'left';
	return exit._tag === 'Failure' ? 'failed' : 'done';
};
