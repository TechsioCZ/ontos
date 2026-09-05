import process from "node:process";

void (async (): Promise<void> => {
	const healthy = await Promise.resolve(true);
	process.exit(healthy ? 0 : 1);
})();
