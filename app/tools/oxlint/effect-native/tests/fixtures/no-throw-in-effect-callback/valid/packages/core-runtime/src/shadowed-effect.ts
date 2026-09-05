// A local shadow named like an Effect namespace must never be treated as the real one.
import { Effect as RealEffect } from 'effect';

void RealEffect;

export function build(): number {
  const Effect = {
    sync: <A>(body: () => A): A => body(),
    gen: <A>(body: () => A): A => body(),
  };
  return Effect.sync(() => {
    if (Math.random() > 1) {
      throw new Error('never');
    }
    return 1;
  });
}
