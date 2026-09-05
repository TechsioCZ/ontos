// expect-count: 10
// The same dictionary hidden in every syntactic position an author might reach for.
import type { ComponentType } from 'react';

// 1. generic default
export type Bag<T = Record<string, string | undefined>> = T;

// 2. class field, 3. static field, 4. method parameter, 5. accessor return
export class EnvironmentHolder {
	readonly environment: Record<string, string | undefined> = {};

	static readonly defaults: Readonly<Record<string, string | undefined>> = {};

	merge(extra: ReadonlyArray<Record<string, string | undefined>>): void {
		void extra;
	}

	get snapshot(): Record<string, undefined | string> {
		return this.environment;
	}
}

// 6. `as`, 7. `satisfies`
export const casted = {} as Record<string, string | undefined>;
export const checked = {} satisfies Record<string, string | undefined>;

// 8. parenthesised / whitespace-mangled union members
export type Spaced = Record<string, (string) | ((undefined))>;

// 9. deep transparent wrappers around `Partial<Record<string, string>>`
export type DeeplyWrapped = Readonly<Partial<Readonly<Readonly<Record<string, string>>>>>;

// 10. nested index signature inside a returned type literal, in a TSX file
export const describe = (): { readonly values: { readonly [name: string]: string | undefined } } => ({ values: {} });

export const Panel: ComponentType<{ readonly bag: Bag }> = ({ bag }) => <span>{String(bag)}</span>;
