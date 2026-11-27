import { Effect, Equal, Option } from 'effect';
import { Atom } from 'effect/reactivity';

interface Attempt<Payload> {
  readonly key: string;
  readonly payload: Payload;
}

/**
 * The idempotency key of an Action form: a retry of the same payload reuses the key of the attempt
 * before it, so a lost answer never commits twice; any edit to the payload starts a new attempt.
 * Once the command commits, `settle` forgets the attempt, so the next submit is a new command.
 */
export const makeActionAttempt = <Payload, E>(newKey: Effect.Effect<string, E>) => {
  const last = Atom.make(Option.none<Attempt<Payload>>()).pipe(Atom.keepAlive);
  const remember = (get: Atom.FnContext, payload: Payload) => (key: string) =>
    Effect.sync(() => get.set(last, Option.some({ key, payload })));
  return {
    /** The key of this payload's attempt: the previous key while the payload is unchanged. */
    key: (get: Atom.FnContext, payload: Payload): Effect.Effect<string, E> => {
      const previous = Option.filter(get(last), (attempt) => Equal.equals(attempt.payload, payload));
      return Option.isSome(previous)
        ? Effect.succeed(previous.value.key)
        : newKey.pipe(Effect.tap(remember(get, payload)));
    },
    /** Forgets the attempt after its command committed. */
    settle: (get: Atom.FnContext): Effect.Effect<void> => Effect.sync(() => get.set(last, Option.none())),
  };
};
