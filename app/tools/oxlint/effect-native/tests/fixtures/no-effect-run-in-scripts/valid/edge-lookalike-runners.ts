// Scope resolution for *bare* runner bindings: a parameter, a local function and a destructured
// property that merely share the imported runner's name are not the `effect` binding, so only the
// single top-level run counts. `runtime.runPromise` (A1's prescription) is likewise not reported.
import { runPromise, succeed } from "effect/Effect";

const program = succeed(1);

const workerPool = { runPromise: async (value: number): Promise<number> => value };
const { runPromise: workerRun } = workerPool;

const withInjectedRunner = async (runPromise: (value: number) => Promise<number>): Promise<number> =>
	await runPromise(1);

declare const runtime: { readonly runPromise: <A>(effect: unknown) => Promise<A> };
const viaRuntime = async (): Promise<number> => await runtime.runPromise<number>(program);

void workerRun;
void withInjectedRunner;
void viaRuntime;

await runPromise(program);
