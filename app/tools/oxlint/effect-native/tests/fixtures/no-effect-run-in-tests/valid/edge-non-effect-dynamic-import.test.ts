// Dynamic imports of other modules, and of non-Effect effect submodules, are not run sites.
declare const it: (name: string, body: () => Promise<void>) => void;

it("loads unrelated modules", async () => {
	const Schema = await import("effect/Schema");
	const { runPromise } = await import("./tests/support/effect-double.ts");
	const client = await import("./tests/support/client.ts");
	runPromise("payload");
	client.runPromise("payload");
	Schema.decodeUnknownSync(Schema.String);
});
