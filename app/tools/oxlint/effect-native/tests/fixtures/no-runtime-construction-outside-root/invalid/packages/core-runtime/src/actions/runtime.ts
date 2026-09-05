// expect-count: 3
// A1: a library module building its own runtime graph. The handler requirements belong in `R`.
import { Effect, Layer, ManagedRuntime } from 'effect';

declare const handlerRequirements: Layer.Layer<never>;
declare const serverLayer: Layer.Layer<never>;

const local = ManagedRuntime.make(handlerRequirements);

export const runHandler = async (): Promise<number> => local.runPromise(Effect.succeed(1));

// Point-free: handing the constructor around is the same defect.
export const boot = Layer.toRuntime;

// Optional chaining still resolves to the effect namespace.
export const maybe = ManagedRuntime?.make(serverLayer);
