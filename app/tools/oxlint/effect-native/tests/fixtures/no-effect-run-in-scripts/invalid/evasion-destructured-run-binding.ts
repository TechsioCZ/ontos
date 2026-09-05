// expect-count: 1
// B3/A1 evasion: destructuring the runner off the namespace leaves no MemberExpression behind.
import { Effect } from "effect";

const { runFork } = Effect;
const program = Effect.succeed(1);

function schedule(): void {
	void runFork(program);
}

void schedule;
