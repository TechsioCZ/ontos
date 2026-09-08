// Parser/matcher stress: type-only member queries, private names, dynamic keys, non-run members and
// a same-shaped object from another package. None of these start an Effect root fiber.
import { Effect } from "effect";

const program = Effect.succeed(1);

type Runner = typeof Effect.runPromise;
declare const declared: Runner;

class Box {
	#runPromise = 1;
	static read(Effect: Box): number {
		return Effect.#runPromise;
	}
}

const key: "runPromise" = "runPromise";
const dynamic = (): unknown => Effect[key];

const workerPool = { runPromise: async (n: number): Promise<number> => n };
const usesLookalike = async (): Promise<number> => await workerPool.runPromise(1);

void declared;
void Box;
void dynamic;
void usesLookalike;
void Effect.runtime;
void program;
