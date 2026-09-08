// Re-exports and dynamic imports only count as Effect linkage when they name `effect` itself.
export { helper } from './helper.ts';
export * from './other-effects.ts';

export const check = async (exit: { readonly _tag: string }): Promise<boolean> => {
	const lazy = await import('./lazy-effect.ts');
	return lazy.ready && exit._tag === 'Failure' && exit._tag !== 'Some';
};
