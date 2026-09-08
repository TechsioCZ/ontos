// Parser stress: private-name `in`, static blocks, computed and numeric keys, accessors,
// generators, deep nesting, optional calls and long cast chains. None of it is problem-shaped.
import type { ReactElement } from 'react';

declare const key: string;
declare const spread: Record<string, unknown>;
declare const error: { readonly message: string };

export class Weird {
  static #instances = 0;
  #secret = 1;

  static {
    Weird.#instances += 1;
  }

  has(value: object): boolean {
    return #secret in value;
  }
}

export const odd = {
  ...spread,
  [key]: 1,
  200: 'ok',
  'quoted-key': 'x',
  get status(): number {
    return 503;
  },
  async run(): Promise<number> {
    return 1;
  },
  *iterate(): Generator<number> {
    yield 1;
  },
};

export const nested = { a: { b: { c: { d: { e: { status: 204 } } } } } };

export const chained = { note: String(error?.message ?? '') };

export const cast = { status: 503 as unknown as number as unknown as number };

export const Fragmented = (): ReactElement => (
  <>
    {[1, 2].map((value) => (
      <span key={value}>{value}</span>
    ))}
  </>
);
