// expect-count: 2
// The only link to Effect is a dynamic `import('effect')` reached at runtime, so an
// ImportDeclaration-only linkage check waves the whole file through.
export const run = async (exit: { readonly _tag: string }): Promise<string> => {
	const { Exit } = await import('effect');
	if (exit._tag === 'Failure') return 'failed';
	return Exit.succeed(1)._tag === 'Success' ? 'ok' : 'other';
};
