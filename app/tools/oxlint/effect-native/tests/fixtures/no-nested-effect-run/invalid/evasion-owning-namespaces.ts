// expect-count: 3
// Stream / Schedule / Fiber callbacks are Effect-owned code too.
import { Effect, Fiber, Schedule, Stream } from "effect";

declare const program: Effect.Effect<number>;
declare const source: Stream.Stream<number>;
declare const schedule: Schedule.Schedule<number>;
declare const fiber: Fiber.Fiber<number>;

export const mapped = Stream.map(source, () => Effect.runSync(program));

export const checked = Schedule.check(schedule, () => {
  Effect.runSync(program);
  return true;
});

export const matched = Fiber.match(fiber, {
  onFailure: () => Effect.runSync(program),
  onSuccess: (value: number) => value,
});
