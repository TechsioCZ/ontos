/**
 * Syntax-stress probe: async generator, `satisfies`/`as`, optional chaining and computed member access
 * in the generator's own code, with no template literal anywhere.
 */
const registry = new Map<string, string>();

export async function* walk(paths: readonly string[]): AsyncGenerator<string> {
	for (const path of paths) {
		yield await Promise.resolve(path);
	}
}

export const options = { mode: 'strict' } satisfies Record<string, string>;
export const alias = (options as { readonly mode: string }).mode;
export const maybe = registry.get('x')?.trim();
export const size = registry['size' as keyof typeof registry];
