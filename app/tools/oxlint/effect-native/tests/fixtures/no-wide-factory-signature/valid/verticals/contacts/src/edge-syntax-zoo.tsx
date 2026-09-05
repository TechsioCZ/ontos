import { Effect, Layer } from 'effect';

declare module 'node:util' {
  interface ContactsFormatters {
    readonly makeLabel: (tenant: string, module: string) => string;
    readonly formatEverything: (a: 1, b: 2, c: 3, d: 4) => string;
  }
}

type Ports = {
  readonly makeKey: (tenant: string, module: string) => string;
  readonly resolveEverything: (a: 1, b: 2, c: 3, d: 4) => void;
};

const Ω日本語Renderer = (a: 1, b: 2, c: 3) => [a, b, c];

/** Within the limit. */
export const makeSnapshot = (rows: readonly string[], now: Date) => Object.freeze({ now, rows });

/** A `this` parameter is a type annotation, not a collaborator. */
export function makeBoundKey(this: Ports, tenant: string, module: string) {
  return this.makeKey(tenant, module);
}

/** Callbacks keep their own signatures: `Array#map` / `reduce` are not factories. */
export const rows = ['a'].map((value, index, all) => `${value}${index}${all.length}`);
export const total = [1].reduce((accumulator, value, index, all) => accumulator + value + index + all.length, 0);

export const makeRenderer = (items: readonly string[]) =>
  items.map((item, index, all) => <li key={index}>{`${item}${all.length}`}</li>);

class Registry {
  readonly #secret = 1;
  constructor(readonly dependencies: unknown) {}
  makeKey(tenant: string, module: string) {
    return `${tenant}:${module}:${this.#secret}`;
  }
  handleEverything(a: 1, b: 2, c: 3, d: 4) {
    return [a, b, c, d, Ω日本語Renderer(1, 2, 3)];
  }
}

/** The Effect-native target shape, with a wide-looking generator callback that has no name. */
export const RegistryLive = Layer.effect(
  RegistryTag,
  Effect.gen(function* () {
    const dependencies = yield* Dependencies;
    return new Registry(dependencies);
  }),
);

export const Panel = (): JSX.Element => (
  <>
    <section data-testid="contacts">{`${String(total)}${rows.length}`}</section>
  </>
);
