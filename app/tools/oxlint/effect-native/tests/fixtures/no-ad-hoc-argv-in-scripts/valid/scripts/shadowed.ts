// Alias / shadowing edge cases: only the real ambient argv array reports.
interface FakeProcess {
	readonly argv: readonly string[];
}

function run(process: FakeProcess): string {
	return process.argv.slice(2).join(" ");
}

const Bun = { argv: ["prepare", "--verbose"] };
const local = Bun.argv[2];

const argv = ["--dry-run"];
const flag = argv.includes("--dry-run");

type ArgvShape = typeof globalThis.process.argv;

export { flag, local, run };
export type { ArgvShape };
