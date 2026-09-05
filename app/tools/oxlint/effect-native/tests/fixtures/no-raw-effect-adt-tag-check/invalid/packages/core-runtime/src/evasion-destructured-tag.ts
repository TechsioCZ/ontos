// expect-count: 2
// Evasion probe: the identical raw ADT check spelled through a destructured `_tag` and through a
// local alias. Nothing else in the plugin covers this for ADT tags — `no-manual-tag-comparison`
// skips `adtTags` and blesses destructured locals, and `prefer-match-over-tag-switch` only owns
// `switch` discriminants — so if this rule ignores it, audit C2 has a hole.
import { Exit, Option } from 'effect';

export const inspect = (option: Option.Option<number>, exit: Exit.Exit<number, Error>): string => {
	const { _tag } = option;
	const exitTag = exit._tag;
	if (_tag === 'None') return 'none';
	return exitTag === 'Failure' ? 'failed' : 'ok';
};
