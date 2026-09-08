import { Array as Arr, Chunk, Effect, Option, Schema } from 'effect';

declare const ids: readonly string[];
declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;
declare const chunk: Chunk.Chunk<number>;
declare const first: Option.Option<number>;
declare const second: Option.Option<number>;

// Same member names, different namespaces: none of these are Effect fan-out.
export const options = Option.all([first, second]);
export const parts = Arr.partition(ids, (id) => id.length > 2);
export const kept = Chunk.filterMap(chunk, (value) => Option.some(value));
export const positive = Schema.Number.pipe(Schema.filter((value) => value > 0));

// Bounded for contrast, so the file is not trivially free of Effect fan-out.
export const both = Effect.all([left, right], { concurrency: 2 });
