// Per-event facts, not ambient identity: the audit blesses structured Effect.log* annotations.
import { Effect, Schedule } from 'effect';

declare const result: {
	claimed: number;
	dead: number;
	deliveriesCreated: number;
	failed: number;
	messagesMatched: number;
	retried: number;
	succeeded: number;
};
declare const error: { _tag: string };

export const cycle = Effect.succeed(result).pipe(
	Effect.andThen(
		Effect.annotateLogs(Effect.logInfo('Outbox polling cycle completed'), {
			claimed: result.claimed,
			dead: result.dead,
			deliveriesCreated: result.deliveriesCreated,
			failed: result.failed,
			messagesMatched: result.messagesMatched,
			retried: result.retried,
			succeeded: result.succeeded,
		}),
	),
	Effect.tapError(() =>
		Effect.annotateLogs(Effect.logError('Outbox polling cycle failed'), { errorTag: error._tag }),
	),
	Effect.repeat(Schedule.spaced('1 seconds')),
);

export const upstream = Effect.annotateLogs(
	Effect.logError('ARES subject request returned an upstream failure'),
	{ upstreamStatus: 503, outcome: 'persistence_failure' },
);
