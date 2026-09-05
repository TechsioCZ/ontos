// expect-count: 3
import { Effect } from 'effect';

declare const ids: readonly string[];
declare const load: (id: string) => Effect.Effect<string>;
declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;

export async function* pages(): AsyncGenerator<unknown> {
  yield Effect.all([left, right]);
  for await (const id of ids) {
    yield Effect.forEach([id, id], load);
  }
}

export const nested = async (): Promise<unknown> => {
  const inner = async () => Effect.forEach(ids, load);
  return await inner();
};
