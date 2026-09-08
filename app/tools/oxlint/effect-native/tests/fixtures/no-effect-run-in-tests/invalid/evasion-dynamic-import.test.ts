// expect-count: 2
// `vi.resetModules()` / `rstest.resetModules()` style tests reach Effect through a dynamic import.
declare const it: (name: string, body: () => Promise<void>) => void;
declare const program: unknown;

it("runs through a dynamic import", async () => {
	const { runPromise } = await import("effect/Effect");
	const Effect = await import("effect/Effect");
	await runPromise(program as never);
	Effect.runSync(program as never);
});
