import { Effect, Match, Option, Schema } from 'effect';

export class ActionTransactionError extends Schema.TaggedError<ActionTransactionError>()('ActionTransactionError', {
	reason: Schema.String,
}) {}

type Envelope = {
	readonly _tag: string;
	readonly _tagName?: string;
	readonly tag?: string;
	readonly _tags?: string;
};

/** Near-misses: other properties, non-literal operands, non-equality operators, domain tags. */
export const lookalikes = (left: Envelope, right: Envelope, error: ActionTransactionError, user: Option.Option<string>) =>
	Effect.sync(() => {
		if (left._tag === right._tag) return 'tag-to-tag';
		if (left._tagName === 'Some') return 'other-property';
		if (left.tag === 'Failure') return 'no-underscore';
		if (left._tags === 'Success') return 'plural-property';
		if ('Some' in left) return 'in-operator';
		if (left._tag > 'Some') return 'relational';
		if (left._tag === 'SOME' || left._tag === 'some') return 'wrong-case';
		if (left._tag !== undefined) return 'defined';
		if (error._tag === 'ActionTransactionError') return 'domain-tag';
		if (Option.isSome(user)) return user.value;
		const pattern = { _tag: 'Some' } as const;
		return Match.value(right).pipe(
			Match.when({ _tag: 'Failure' }, () => 'match'),
			Match.orElse(() => `${pattern._tag}`),
		);
	});
