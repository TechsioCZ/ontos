// `**/*.e2e.*` — browser-driver adapters are D tier and stay outside the harness requirement.
import { Effect } from "effect";

declare const test: (name: string, body: () => Promise<void>) => void;
declare const smoke: Effect.Effect<void>;

test("smoke", async () => {
	await Effect.runPromise(smoke);
});
