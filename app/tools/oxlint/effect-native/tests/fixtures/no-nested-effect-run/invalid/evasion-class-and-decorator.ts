// expect-count: 2
// Class bodies and decorated methods inside Effect-owned callbacks.
import { Effect } from "effect";

declare const program: Effect.Effect<number>;
declare const logged: MethodDecorator;

export const bootstrap = Effect.sync(() => {
  class Repo {
    static readonly eager = Effect.runSync(program);

    @logged
    save(): void {
      void Effect.runPromise(program);
    }
  }
  return new Repo();
});
