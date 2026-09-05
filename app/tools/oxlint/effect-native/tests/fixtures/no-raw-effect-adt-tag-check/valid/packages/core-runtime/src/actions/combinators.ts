import { Cause, Effect, Exit, Match, Option, Result } from 'effect';

export const inspect = (failure: Option.Option<Error>, exit: Exit.Exit<number, Error>) =>
	Effect.sync(() => {
		if (Option.isSome(failure)) return failure.value.message;
		if (Exit.isFailure(exit)) return Cause.pretty(exit.cause);
		return Option.match(failure, { onNone: () => 'none', onSome: (error) => error.message });
	});

export const viaMatch = (outcome: Result.Result<string, Error>) =>
	Match.value(outcome).pipe(
		Match.when({ _tag: 'Success' }, (value) => value.success),
		Match.when({ _tag: 'Failure' }, () => 'failed'),
		Match.exhaustive,
	);

export const cause = (exit: Exit.Exit<number, Error>) =>
	Exit.match(exit, { onFailure: (value) => Cause.pretty(value), onSuccess: (value) => String(value) });
