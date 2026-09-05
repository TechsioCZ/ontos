// expect-count: 3
// A dynamic import of the root barrel still reaches `Effect.run*` through `.Effect`, and a
// destructured `{ Effect }` from it is the namespace itself.
declare const it: (name: string, body: () => Promise<void>) => void;
declare const program: unknown;

it("runs through a dynamic root import", async () => {
	const Lib = await import("effect");
	const { Effect } = await import("effect");
	await Lib.Effect.runPromise(program as never);
	Effect.runSync(program as never);
	await Effect.runPromiseExit(program as never);
});
