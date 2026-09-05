import { Effect, Option } from 'effect';

const KIND = 'Success' as const;

export const misc = (failure: Option.Option<string>, tag: string) =>
	Effect.sync(() => {
		// Not a `_tag` member, not an ADT tag literal, and not an equality comparison.
		const record = { _tag: 'Some' as const, value: failure };
		const dynamic = tag === KIND;
		const other = record.value._tag === 'SomethingElse';
		const notTag = record._id === 'Some';
		return dynamic || other || notTag || `${record._tag}`.length > 0;
	});
