// The named-callback hop must not turn an outer seam into a violation: `boot` and `drain` are only
// ever referenced from module scope / a plain framework adapter, never from Effect-owned code.
import { Effect } from "effect";

declare const program: Effect.Effect<number>;
declare const onRequest: (handler: () => Promise<unknown>) => void;

const boot = async (): Promise<number> => await Effect.runPromise(program);

function drain(): number {
  return Effect.runSync(program);
}

void boot();

onRequest(async () => await boot());

export const started = drain();
