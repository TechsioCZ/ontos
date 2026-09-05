// Lookalikes that must never report: an injected parameter, a block-scoped class and an object key
// all named like an Effect namespace, in a file that really does import `effect`.
import { Effect, Match } from 'effect';

interface FakeEffect {
  readonly sync: <A>(body: () => A) => A;
}

// Parameter shadow.
export function withInjectedRuntime(Effect: FakeEffect): number {
  return Effect.sync(() => {
    throw new Error('parameter shadow, not the effect package');
  });
}

// Block-scoped class shadow.
export function withLocalMatch(): string {
  class Match {
    static when<A>(_pattern: string, body: () => A): A {
      return body();
    }
  }
  return Match.when('x', () => {
    throw new Error('class shadow, not the effect package');
  });
}

// A property *key* named like a namespace is not a callee.
export const handlers = {
  Effect: () => {
    throw new Error('property key, not a combinator call');
  },
};

void Effect;
void Match;
