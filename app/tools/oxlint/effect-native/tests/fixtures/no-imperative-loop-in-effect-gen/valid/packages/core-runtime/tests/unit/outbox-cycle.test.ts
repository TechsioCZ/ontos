// Tests are out of scope by default (`includeTests: false`): audit B2 owns the test harness and
// prescribes `itEffect`/`TestClock`, not this rule.
import { Effect } from "effect";

declare const repository: { readonly claimNext: () => Effect.Effect<string | null> };

export const harness = Effect.gen(function* () {
	let claimed = 0;
	while (claimed < 5) {
		const claim = yield* repository.claimNext();
		if (claim === null) {
			break;
		}
		claimed += 1;
	}
	return claimed;
});
