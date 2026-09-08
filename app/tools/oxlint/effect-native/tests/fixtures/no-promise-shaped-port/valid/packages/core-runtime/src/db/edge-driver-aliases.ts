/** Every import/alias/access form of the blessed Promise -> Effect boundary. */
import { Effect as Eff } from "effect";

const executor = { insert: (rows: readonly string[]) => Promise.resolve(rows) };
const decode = (cause: unknown) => cause;

export const aliasedNamed = Eff.tryPromise({ catch: decode, try: async () => await executor.insert([]) });

export const computed = Eff["tryPromise"]({ catch: decode, try: async () => await executor.insert([]) });

export const optionalCall = Eff?.tryPromise({ catch: decode, try: async () => await executor.insert([]) });

export const plainPromise = Eff.promise(async () => await executor.insert([]));

export const mapped = Eff.tryMapPromise(Eff.succeed(1), {
	catch: decode,
	try: async (value: number) => await executor.insert([String(value)]),
});
