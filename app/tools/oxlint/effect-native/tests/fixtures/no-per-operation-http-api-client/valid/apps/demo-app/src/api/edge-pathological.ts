// Syntax stress: default-exported async generator, labels, try/finally, tagged templates,
// `as const satisfies`. Nothing constructs a client.
import { Effect } from 'effect';
import { ContactsClientTag } from './client-layer.ts';

export default async function* run(...ids: readonly string[]) {
  outer: for (const id of ids) {
    try {
      yield await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* ContactsClientTag;
          return yield* client.customerList.remove({ path: { id } });
        }),
      );
    } catch {
      continue outer;
    } finally {
      void id;
    }
  }
}

export const raw = String.raw`a${1}b`;
export const literals = { page: 1 } as const satisfies Record<string, number>;
