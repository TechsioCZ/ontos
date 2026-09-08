// expect-count: 4
// updateService deliberately remains unreported: it retains the service requirement.
// A1: per-request service/reference provision belongs at the HTTP seam, not inside a component or service.
import { Effect, pipe } from "effect";

declare const Clock: never;
declare const clock: never;
declare const RequestId: never;
declare const requestId: string;
declare const makeClock: Effect.Effect<never, never, never>;
declare const program: Effect.Effect<string, never, never>;

export function useGovernedRead(): unknown {
  const bound = pipe(program, Effect.provideService(Clock, clock));
  const withReference = program.pipe(Effect.provideReferences({ RequestId: requestId }));
  const withEffect = program.pipe(Effect.provideServiceEffect(Clock, makeClock));
  const updated = program.pipe(Effect.updateService(Clock, (value: never) => value));
  const many = program.pipe(Effect.provideServices({ Clock: clock }));
  return <span>{String([bound, withReference, withEffect, updated, many])}</span>;
}
