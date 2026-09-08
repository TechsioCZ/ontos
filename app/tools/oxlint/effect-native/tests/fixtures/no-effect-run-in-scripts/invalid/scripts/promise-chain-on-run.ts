// expect-count: 1
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

const provisioning = Effect.succeed({ grantCount: 3 });

const main = (): void => {
	Effect.runPromise(provisioning)
		.then((result) => {
			console.log(`Provisioned ${result.grantCount} grants.`);
		})
		.catch((error: unknown) => {
			console.error(error);
			process.exitCode = 1;
		});
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
