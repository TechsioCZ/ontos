// expect-count: 5
import { Effect } from "effect";

declare const rstest: { mock: (path: string, factory: () => unknown) => void };
declare const it: (name: string, body: () => Promise<void>) => void;
declare const programs: ReadonlyArray<Effect.Effect<string>>;

rstest.mock("../../src/api/contacts-client.ts", () => ({
	runEffectRequest: Effect.runPromise,
}));

const { runPromise, runSync } = Effect;

it("fans out", async () => {
	const results = await Promise.all(programs.map(Effect.runPromise));
	const first = await runPromise(programs[0]!);
	const second = runSync(programs[0]!);
	return void [results, first, second];
});

export function Probe(): JSX.Element {
	return <span data-value={String(Effect.runSync(programs[0]!))} />;
}
