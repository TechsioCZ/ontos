// expect-count: 9
// Evasion probe: parenthesised/`as`/`satisfies`/non-null wrappers, optional + computed member
// access, template-literal keys, reversed operand order, escaped and `as const` tag literals.
import { Effect } from 'effect';
import type { Exit, Option } from 'effect';

type Maybe = Option.Option<number> | undefined;

export const inspect = (exit: Exit.Exit<number, Error>, maybe: Maybe) =>
	Effect.sync(() => {
		if (((((exit))))._tag === 'Failure') return 'deep-parens';
		if (maybe?.['_tag'] === 'Some') return 'optional-computed';
		if (maybe?.[`_tag`] !== 'None') return 'optional-computed-template';
		if ('Failure' === (exit as Exit.Exit<number, Error>)._tag) return 'reversed-as';
		if ((exit satisfies Exit.Exit<number, Error>)._tag === 'Failure') return 'satisfies';
		if (exit!._tag === '\u0053uccess') return 'escaped-literal';
		if ((maybe as Option.Option<number>)!._tag === 'Some') return 'as-then-non-null';
		if (maybe?._tag === ('Some' as const)) return 'as-const-literal';
		return `Some` === maybe?._tag ? 'reversed-template' : 'none';
	});
