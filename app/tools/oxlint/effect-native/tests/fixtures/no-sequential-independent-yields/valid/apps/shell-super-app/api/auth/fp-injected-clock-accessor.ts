// Regression fixture for a false positive observed on tracked source:
// `apps/shell-super-app/api/auth/gateway-issuer.ts:87`.
//
// `dependencies.currentTimeSeconds` and `dependencies.generateJti` are injected *zero-latency*
// Effect values (`Clock.currentTimeMillis`, `Effect.sync`), not remote reads. Audit B1 targets
// "independent remote providers and enrichment reads"; a Clock read has no latency to overlap, so
// `Effect.all([loadConfig, currentTimeSeconds], { concurrency: 2 })` buys nothing and only adds a
// fork. The rule already blesses the identical shape when the clock arrives as a bare
// `Context.Service` tag (`const now = yield* Clock;`) or as a direct `effect` member
// (`yield* Clock.currentTimeMillis`) — reaching it through an injected dependencies record must not
// change the verdict.
//
// The reported message is also not actionable here: it renders the suggestion as
// `currentTimeSeconds(...)`, but the dependency is an Effect *value*, not a function.
import { Clock, Effect } from "effect";

interface IssuerDependencies {
	readonly currentTimeSeconds: Effect.Effect<number>;
	readonly generateJti: Effect.Effect<string>;
	readonly loadConfig: Effect.Effect<{ readonly issuer: string }>;
}

export const liveDependencies: IssuerDependencies = {
	currentTimeSeconds: Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000))),
	generateJti: Effect.sync(() => globalThis.crypto.randomUUID()),
	loadConfig: Effect.succeed({ issuer: "https://issuer.example" }),
};

export const issueAssertion = (dependencies: IssuerDependencies = liveDependencies) =>
	Effect.gen(function* issueAssertionEffect() {
		const configuration = yield* dependencies.loadConfig;
		const issuedAt = yield* dependencies.currentTimeSeconds;
		const jti = yield* dependencies.generateJti;
		return { issuedAt, issuer: configuration.issuer, jti };
	});
