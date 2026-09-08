// expect-count: 8
// Evasion probe: aliased named imports, submodule namespace import, member-of-member imports,
// class members (static field, getter, method), callbacks and nested arrow bodies.
import { Option as O, Result as Res } from 'effect';
import * as Ex from 'effect/Exit';
import { isSome } from 'effect/Option';

function taggedSome(value: O.Option<number>): boolean {
	return value._tag !== 'None';
}

export const somes = (values: readonly O.Option<number>[]) => values.filter((value) => value._tag === 'Some');

export const anySome = (values: readonly O.Option<number>[]) => values.some(taggedSome);

export class ExitInspector {
	readonly #label: string;

	static readonly failed = (exit: Ex.Exit<void>) => exit._tag === 'Failure';

	constructor(label: string) {
		this.#label = label;
	}

	get broken(): (exit: Ex.Exit<void>) => string {
		return (exit) => (exit._tag === 'Failure' ? this.#label : 'ok');
	}

	describe(result: Res.Result<string, Error>): string {
		return result._tag === 'Success' ? 'ok' : result._tag === 'Failure' ? 'bad' : 'other';
	}
}

export const nested = (option: O.Option<{ readonly inner: O.Option<number> }>) =>
	option._tag === 'Some' && option.value.inner._tag !== 'None' && isSome(option);
