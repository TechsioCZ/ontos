// Decorators parse cleanly and an `argv`-named option bag is not argv.
function configure(_options: { readonly argv: readonly string[] }) {
	return (_target: unknown) => {};
}

@configure({ argv: ["prepare"] })
class Runner {}

export { Runner };
