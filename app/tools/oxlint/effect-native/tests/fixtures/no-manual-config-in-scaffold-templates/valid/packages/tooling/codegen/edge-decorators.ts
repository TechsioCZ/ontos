/** Decorators, private fields and generics in a codegen file whose template emits the target shape. */
const emitter = (target: unknown): unknown => target;

@emitter
class TemplateRegistry {
	readonly header = `import { Config, Redacted, Schema } from 'effect';`;
	#cache = new WeakMap<object, string>();

	render<T extends { readonly id: string }>(input: T): string {
		const rendered = `export const audience = Schema.Literal('${input.id}');`;
		this.#cache.set(input, rendered);
		return rendered;
	}
}

export { TemplateRegistry };
