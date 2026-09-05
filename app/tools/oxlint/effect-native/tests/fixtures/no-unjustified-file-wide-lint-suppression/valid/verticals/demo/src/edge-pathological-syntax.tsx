// Parser stress with no directive anywhere: decorators, static blocks, accessors, private fields,
// async generators, `satisfies`, generic arrows in TSX, optional chaining and computed access.
const register = (target: unknown, key?: unknown): void => void (target ?? key);

export class Registry {
	static readonly kind = "registry" as const;
	static {
		void Registry.kind;
	}
	@register accessor label: string = "x";
	async *stream(): AsyncGenerator<number> {
		yield 1;
	}
	#secret = 1;
	get secret(): number {
		return this.#secret;
	}
}

export const identity = <T,>(value: T): T => value;
export const shape = { a: 1 } satisfies Record<string, number>;
export const deep = (o?: { a?: { readonly [k: string]: number } }): number | undefined => o?.a?.["k"];
export const View = (): JSX.Element => <>{`t${identity(1)}`}</>;
