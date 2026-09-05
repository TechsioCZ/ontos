import { Effect } from 'effect';

declare const promises: readonly Promise<number>[];
declare const values: readonly number[];
declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;

// A local shadow named `Effect` is not the `effect` import.
export const shadowed = (() => {
  const Effect = { all: <A,>(value: A): A => value, forEach: <A,>(value: A): A => value };
  return Effect.all([1, 2]);
})();

export const viaParameter = (Effect: { all: (value: unknown) => unknown }) => Effect.all([1, 2]);

// Native collection operations: the audit's D tier keeps these as they are.
export const settled = Promise.all(promises);
export const evens = values.filter((value) => value % 2 === 0);
export const doubled = values.map((value) => value * 2);
export const total = values.reduce((sum, value) => sum + value, 0);

// A same-named member on something that is not an `effect` namespace.
const Effects = { all: <A,>(value: A): A => value };
export const notEffect = Effects.all([left, right]);

export const label = 'Effect.all';
export const Element = () => <div data-all="all">{String(evens.length)}</div>;
