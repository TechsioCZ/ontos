// expect-count: 3
// S1: the Effect -> Promise -> Effect transaction sandwich re-supplies the environment it lost.
import { Effect, Exit } from "effect";

declare const database: {
  readonly transaction: <A>(body: (tx: unknown) => Promise<A>) => Promise<A>;
};
declare const handlerRequirements: never;
declare const serviceFactory: (tx: unknown) => Effect.Effect<unknown, never, never>;
declare const handler: (payload: unknown, services: unknown) => Effect.Effect<unknown, never, never>;
declare const payload: unknown;

export const runGovernedAction = () =>
  database.transaction(async (tx) => {
    const services = await Effect.runPromiseExit(
      serviceFactory(tx).pipe(Effect.provide(handlerRequirements)),
    );
    const handlerExit = await Effect.runPromiseExit(
      Effect.suspend(() => handler(payload, services)).pipe(Effect.provide(handlerRequirements)),
    );
    if (Exit.isFailure(handlerExit)) {
      return Effect.provide(handler(payload, services), handlerRequirements);
    }
    return handlerExit.value;
  });
