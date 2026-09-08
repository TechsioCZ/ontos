// expect-count: 7
// Class bodies, static blocks, property initialisers, accessors, async generators and doubly nested
// arrows are all library code: the seam exemption must never leak into any of them.
import { Effect } from "effect";

declare const RequirementsLayer: never;
declare const program: Effect.Effect<string, never, never>;

export class ReadRuntime {
  static readonly boot = program.pipe(Effect.provide(RequirementsLayer));
  readonly field = program.pipe(Effect.provide(RequirementsLayer));
  static {
    void program.pipe(Effect.provide(RequirementsLayer));
  }
  run(): unknown {
    return program.pipe(Effect.provide(RequirementsLayer));
  }
  get lazy(): unknown {
    return Effect.provide(program, RequirementsLayer);
  }
  async *stream(): AsyncGenerator<unknown> {
    yield await Effect.runPromise(program.pipe(Effect.provide(RequirementsLayer)));
  }
  #secret = () => () => Effect.provide(program, RequirementsLayer);
  get secret(): unknown {
    return this.#secret;
  }
}
