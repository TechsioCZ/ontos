import { Effect } from 'effect';

declare const ids: readonly string[];
declare const load: (id: string) => Effect.Effect<string>;

// A co-located `.spec.tsx` under `apps/` is still a test file: B1 is about production fan-out.
export const raced = Effect.forEach(ids, load, { concurrency: 'unbounded' });
export const sequential = Effect.forEach(ids, load);
export const Element = (): JSX.Element => <div />;
