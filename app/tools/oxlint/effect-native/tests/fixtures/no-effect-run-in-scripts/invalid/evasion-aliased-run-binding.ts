// expect-count: 2
// B3/A1 evasion: the run function is aliased once at the top level (that reference is treated as
// the script's single edge run) and then called from two helpers, each a fresh root fiber.
import { Effect } from "effect";

const program = Effect.succeed(1);
const run = Effect.runPromise;

async function loadDatabase(): Promise<number> {
	return await run(program);
}

async function loadSpice(): Promise<number> {
	return await run(program);
}

void loadDatabase;
void loadSpice;
