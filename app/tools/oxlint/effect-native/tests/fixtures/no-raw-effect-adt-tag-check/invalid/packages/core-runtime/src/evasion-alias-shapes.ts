// expect-count: 5
// Regression probe for the indirect `_tag` reads: renamed destructuring, a defaulted shorthand, a
// nested pattern, an optional-chained alias initialiser, and an alias read from an inner closure.
// `prefer-match-over-tag-switch` already treats these spellings as must-report for `switch`
// discriminants; for a binary ADT comparison this rule is the sole authority.
import { Exit, Option } from 'effect';

export const renamed = (option: Option.Option<number>): boolean => {
	const { _tag: kind } = option;
	return kind === 'Some';
};

export const defaulted = (envelope: { readonly _tag?: string }): boolean => {
	const { _tag = 'None' } = envelope;
	return _tag !== 'None';
};

export const nested = (envelope: { readonly exit: Exit.Exit<number> }): boolean => {
	const {
		exit: { _tag: exitTag },
	} = envelope;
	return 'Failure' === exitTag;
};

export const chained = (option: Option.Option<number>): boolean => {
	const tag = (option as Option.Option<number>)?._tag;
	return tag === 'Some';
};

export const fromClosure = (exit: Exit.Exit<number>): string => {
	const cached = exit._tag;
	const describe = (): string => (cached === 'Success' ? 'ok' : 'bad');
	return describe();
};
