// expect-count: 6
// Audit B1 evidence shape: `packages/core-runtime/src/outbox/runtime.ts:262` — a claim/drain
// `while` loop around `yield* repository.claimNext(...)` carrying five mutable counters.
import { Effect } from "effect";

interface Claim {
	readonly workerKey: string;
}

declare const repository: {
	readonly claimNext: (owner: string) => Effect.Effect<Claim | null>;
	readonly deliver: (claim: Claim) => Effect.Effect<"dead" | "retry" | "success">;
};

export const runCycle = (maxDeliveries: number, claimOwner: string) =>
	Effect.gen(function* runOutboxCycleEffect() {
		let claimed = 0;
		let dead = 0;
		let failed = 0;
		let retried = 0;
		let succeeded = 0;

		while (claimed < maxDeliveries) {
			const claim = yield* repository.claimNext(claimOwner);
			if (claim === null) {
				break;
			}
			claimed += 1;
			const status = yield* repository.deliver(claim);
			if (status === "dead") {
				dead += 1;
				failed += 1;
			} else if (status === "retry") {
				retried += 1;
			} else {
				succeeded += 1;
			}
		}

		return { claimed, dead, failed, retried, succeeded };
	});
