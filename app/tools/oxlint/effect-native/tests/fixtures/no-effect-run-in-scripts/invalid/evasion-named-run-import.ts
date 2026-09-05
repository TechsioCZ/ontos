// expect-count: 1
// B3/A1 evasion: the runner is imported by name instead of through a namespace, so there is no
// `Effect.runPromise` MemberExpression to match — but the helper still starts a root fiber.
import { runPromise, succeed } from "effect/Effect";

const program = succeed(1);

async function collectConfiguration(): Promise<number> {
	return await runPromise(program);
}

void collectConfiguration;
