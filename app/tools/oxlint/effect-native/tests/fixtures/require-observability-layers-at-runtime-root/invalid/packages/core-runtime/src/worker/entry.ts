// expect-count: 2
// Module-level `Effect.run*` is the process entry. A Logger is installed, Tracer/level are not.
import { Effect, Logger } from 'effect';

declare const program: Effect.Effect<void>;

const logging = Logger.layer([Logger.consoleJson]);

void Effect.runPromise(Effect.provide(program, logging));
