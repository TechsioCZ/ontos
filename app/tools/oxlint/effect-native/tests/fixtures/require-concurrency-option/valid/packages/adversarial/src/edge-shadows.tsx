import { Effect } from 'effect';

declare const left: Effect.Effect<number>;

// A catch-clause binding named `Effect` is not the `effect` import.
export function inCatch(): unknown {
  try {
    return String(left);
  } catch (Effect) {
    return (Effect as unknown as { readonly all: (values: readonly number[]) => number }).all([1, 2]);
  }
}

// A parameter shadow inside a class method.
export class Local {
  run(Effect: { readonly forEach: (values: readonly number[], run: (value: number) => number) => unknown }): unknown {
    return Effect.forEach([1, 2], (value) => value);
  }
}

// A function-declaration shadow inside a nested block.
export const shadowedFunction = (): unknown => {
  function Effect(values: readonly number[]): readonly number[] {
    return values;
  }
  const bag = { all: Effect, forEach: Effect };
  return bag.all([1, 2]);
};

export const Element = (): JSX.Element => <div data-all="Effect.all([a, b])" />;
