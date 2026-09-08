// An `argv` property that is not the process argv array, and a vendored `process`-shaped object.
const config = { argv: ["--dry-run"] as const };
const flags = config.argv.slice(1);

declare const vendor: { readonly process: { readonly argv: readonly string[] } };
const vendored = vendor.process.argv[2];

class Runner {
	private readonly argv: readonly string[] = [];
	read() {
		return this.argv.slice(2);
	}
}

export { Runner, flags, vendored };
