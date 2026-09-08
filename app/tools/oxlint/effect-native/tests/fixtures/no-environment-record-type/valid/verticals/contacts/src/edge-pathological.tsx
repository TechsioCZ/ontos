/** Pathological-but-legal TypeScript: the rule must walk all of it without crashing or reporting. */
declare module 'virtual:ontos-config' {
	export const value: string;
}

export enum Flag {
	On = 'on',
	Off = 'off',
}

@sealed
export abstract class Base<T extends { readonly id: string }> {
	protected constructor(protected readonly value: T) {}

	abstract render(): string;
}

function sealed(target: unknown): void {
	void target;
}

export type Deep = string | (number | (boolean | (null | undefined)));
export type Conditional<T> = T extends ReadonlyArray<infer U> ? Record<string, U> : never;
export type Remapped = { readonly [K in 'a' | 'b' as `ontos_${K}`]?: string };
export type Tupled = readonly [Record<string, string>, ReadonlyMap<string, string>];
export type Recursive = string | { readonly [key: string]: Recursive };

export const Generic = <T,>({ items }: { readonly items: readonly T[] }) => <span>{items.length}</span>;

export async function* stream(): AsyncGenerator<Record<string, string>, void, undefined> {
	yield { ontos: 'value' } as const satisfies Record<string, string>;
}

export const Node = () => (
	<Generic<string> items={[`${Flag.On}`]} />
);
