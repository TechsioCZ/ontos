// expect-count: 2
import { pathToFileURL } from "node:url";

const build = (): number => 0;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const status = build();
	if (status !== 0) {
		process.exit(status);
	}
	process.exitCode = 0;
	process.exit(0);
}
