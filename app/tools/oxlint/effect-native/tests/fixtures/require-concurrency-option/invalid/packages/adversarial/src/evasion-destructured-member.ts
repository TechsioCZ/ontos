// expect-count: 4
import { Effect, Stream } from 'effect';

declare const ids: readonly string[];
declare const load: (id: string) => Effect.Effect<string>;
declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;
declare const source: Stream.Stream<string>;

// Destructuring the combinator off the namespace changes nothing at runtime: still sequential.
const { forEach, all } = Effect;
export const each = forEach(ids, load);
export const both = all([left, right]);

// A plain alias binding is the same fan-out under another name.
const mapEffect = Stream.mapEffect;
export const mapped = mapEffect(source, load);

// Re-binding the whole namespace hides it just as well.
const Fanout = Effect;
export const again = Fanout.all([left, right]);
