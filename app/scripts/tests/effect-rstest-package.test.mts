import { Effect, Equal, Hash, Schema } from 'effect';
import { FastCheck } from 'effect/testing';
import { addEqualityTesters, expect, it } from 'effect-rstest';

class SemanticValue implements Equal.Equal {
  readonly #key: string;
  readonly representation: string;
  constructor(key: string, representation: string) {
    this.#key = key;
    this.representation = representation;
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return #key in that && this.#key === that.#key;
  }
  [Hash.symbol](): number {
    return this.#key.length;
  }
}

addEqualityTesters();

it('the installed package honors Effect equality without replacing native assertions', () => {
  expect(new SemanticValue('same', 'left')).toEqual(new SemanticValue('same', 'right'));
  expect(new SemanticValue('left', 'same')).not.toEqual(new SemanticValue('next', 'same'));
  expect({ value: 1 }).toEqual({ value: 1 });
  expect({ value: 1 }).toEqual(expect.objectContaining({ value: 1 }));
});

it.prop(
  'the installed package generates tuple schemas',
  [Schema.Literal('schema'), FastCheck.integer()],
  ([label, value]) => {
    expect(label).toBe('schema');
    expect(Number.isInteger(value)).toBe(true);
  },
);

it.prop(
  'the installed package generates record schemas',
  { value: Schema.Literal('schema') },
  ({ value }) => {
    expect(value).toBe('schema');
  },
);

// Promise assimilation would inspect this success value for a `then` property.
const value = new Proxy(
  {},
  {
    get(): never {
      throw new Error('Effect success values must not reach Promise resolution');
    },
  },
);

it.effect('discards success values at the runner boundary', () => Effect.succeed(value));
it.live('discards live success values at the runner boundary', () => Effect.succeed(value));
