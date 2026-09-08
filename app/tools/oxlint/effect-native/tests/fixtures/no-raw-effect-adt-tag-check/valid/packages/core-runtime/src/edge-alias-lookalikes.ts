import { Option } from 'effect';

declare const envelope: { readonly kind: string; readonly _tagName: string };

/** A parameter named `_tag` is a parameter, not a destructured ADT read. */
export const viaParameter = (_tag: string): boolean => _tag === 'Some';

/** Locals initialised from something other than a `_tag` property. */
export const viaOtherProperty = (): boolean => {
	const { kind } = envelope;
	const label = envelope._tagName;
	return kind === 'Failure' || label === 'Some';
};

/** The inner binding shadows the outer `_tag` alias, so the comparison is not an ADT read. */
export const viaShadowing = (option: Option.Option<string>): boolean => {
	const { _tag } = option;
	const inner = (_tag: string): boolean => _tag === 'Some';
	return inner(String(_tag).slice(0, 0));
};

/** An aliased domain tag stays the `catchTag`/`Match` concern of audit A4. */
export const viaDomainAlias = (error: { readonly _tag: 'ActionTransactionError' }): boolean => {
	const tag = error._tag;
	return tag === 'ActionTransactionError';
};

/** `var` redeclaration means the binding is not provably a tag read. */
export const viaRedeclaration = (option: Option.Option<string>): boolean => {
	var slot = option._tag;
	var slot = 'Some';
	return slot === 'Some';
};
