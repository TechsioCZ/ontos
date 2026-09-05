// expect-count: 2
// Evasion probe: the file's only link to `effect` is a re-export and a dynamic import, so
// `requireEffectImport` (which only scans ImportDeclaration nodes) may wave it through.
export { Option } from 'effect';
export type { Exit } from 'effect';

export const isPresent = (value: { readonly _tag: string }): boolean => value._tag === 'Some';

export const failed = async (exit: { readonly _tag: string }): Promise<string> => {
	const { Cause } = await import('effect');
	return exit._tag === 'Failure' ? Cause.pretty(Cause.empty) : 'ok';
};
