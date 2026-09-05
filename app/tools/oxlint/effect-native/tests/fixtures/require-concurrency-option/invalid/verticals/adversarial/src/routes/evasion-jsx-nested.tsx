// expect-count: 3
import { Effect } from 'effect';

declare const ids: readonly string[];
declare const load: (id: string) => Effect.Effect<string>;
declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;

export const Panel = (): JSX.Element => (
  <section data-model={String(Effect.all([left, right]))}>
    {ids.map((id) => (
      <span key={id}>{String(Effect.forEach(ids, load))}</span>
    ))}
    <em>{String(Effect.all({ left, right }))}</em>
  </section>
);
