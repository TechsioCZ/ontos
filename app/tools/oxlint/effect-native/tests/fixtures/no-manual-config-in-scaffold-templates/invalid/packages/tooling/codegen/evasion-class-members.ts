// expect-count: 1
/** Template held on a class member, emitted from an async generator. */
const cache = new WeakMap<object, string>();

export class BoundaryEmitter {
	static readonly header = `const raw = process.env.ONTOS_GATEWAY_PUBLIC_JWKS;`;

	static {
		cache.set(BoundaryEmitter, BoundaryEmitter.header);
	}

	async *emit(ids: readonly string[]): AsyncGenerator<string> {
		for (const id of ids) {
			yield `export const audience = '${id}';` satisfies string;
		}
	}
}
