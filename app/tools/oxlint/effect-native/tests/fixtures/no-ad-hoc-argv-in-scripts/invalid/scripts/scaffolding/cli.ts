// expect-count: 3
// scripts/scaffolding/cli.mts:665 — the generator's own hand-rolled command dispatch.
const [, entryPath, commandArgument] = process.argv;
const forwarded = process.argv.slice(3);

function withDefault(argumentList: readonly string[] = process.argv) {
	return argumentList.length;
}

export { commandArgument, entryPath, forwarded, withDefault };
