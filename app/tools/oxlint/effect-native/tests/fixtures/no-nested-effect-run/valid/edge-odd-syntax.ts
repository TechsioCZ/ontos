// Static blocks, private fields, getters named like run members, deep parens, comments.
import { Effect } from "effect";

declare const program: Effect.Effect<number>;

class Boot {
  static readonly created = 0;
  #count = 1;

  static {
    void Boot.created;
  }

  get runPromise(): number {
    return this.#count;
  }
}

/** Mentions Effect.runPromise in prose only. */
export const odd = Effect.sync(() => {
  const boot = new Boot();
  return ((((boot.runPromise)))) + (boot?.runPromise ?? 0) + String(program).length;
});
