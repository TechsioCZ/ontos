import * as EffectNs from "effect/Effect";
import { pathToFileURL } from "node:url";

const program = EffectNs.succeed("ok");

const main = async (): Promise<void> => {
	await EffectNs.runPromise(program);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(() => {
		process.exitCode = 1;
	});
}
