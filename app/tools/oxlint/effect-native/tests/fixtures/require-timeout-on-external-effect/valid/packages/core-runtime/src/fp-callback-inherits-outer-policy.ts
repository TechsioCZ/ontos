// FALSE POSITIVE (repo shape): a policy on the enclosing pipe really does bound a bridge that sits
// inside an `Effect.flatMap`/`Effect.forEach` callback — the whole chain is one effect graph, so the
// timeout interrupts the bridge. The rule stops its ancestor walk at the callback boundary.
import { Effect } from 'effect';

declare const db: { readonly read: (id: string) => Promise<string> };
declare const ids: Effect.Effect<readonly string[]>;

export const readAll = ids.pipe(
  Effect.flatMap((values) =>
    Effect.tryPromise({ catch: () => new Error('unavailable'), try: () => db.read(values[0] ?? '') }),
  ),
  Effect.timeout('5 seconds'),
);
