// Parser stress: decorators, static blocks, private fields, `accessor`, async generators,
// class members whose names collide with seam primitives. Only blessed Effect usage.
import { Cause, Effect } from 'effect';

declare const track: (target: unknown, key?: unknown) => void;

export class Supervisor {
  static #started = 0;
  accessor label: string = 'supervisor';
  readonly hasDies = false;
  catchDefect(): boolean { return this.hasDies; }
  static { Supervisor.#started = 1; }
  @track run(): Effect.Effect<never, Error> {
    return Effect.failCause(Cause.fail(new Error('boom')));
  }
  async *ticks(): AsyncGenerator<number> { yield Supervisor.#started; }
}

export const logged = Effect.tapCause(Effect.void, (cause) => Effect.logError(Cause.pretty(cause)));
