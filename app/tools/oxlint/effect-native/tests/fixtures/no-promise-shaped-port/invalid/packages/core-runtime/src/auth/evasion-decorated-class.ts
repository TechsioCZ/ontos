// expect-count: 2
/** Decorators and private/static members must not hide the async port (and must not crash the rule). */
declare function inject(): MethodDecorator;

export class PrincipalStore {
	static readonly kind = "principal";

	@inject()
	async createPrincipal(id: string) {
		return await Promise.resolve(id);
	}

	async #evict(id: string) {
		await Promise.resolve(id);
	}

	evict(id: string) {
		return this.#evict(id);
	}
}
