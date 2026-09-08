// expect-count: 1
// A nested run that is also promise-chained reports exactly once (nestedRun wins).
import { Effect } from "effect";

const program = Effect.succeed(1);

const helper = (): void => {
	void Effect.runPromise(program).then((value) => {
		console.log(value);
	});
};

void helper;
