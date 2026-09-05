/** Lookalikes that must stay silent. */
const OPERATION_KEY = 'operation';
const registryToken: unique symbol = Symbol('@app/core-runtime/edge/registry-token');

/** A string constant used as a computed key is not a symbol slot. */
export const buildConfig = (handler: () => void): Record<string, () => void> => ({
  [OPERATION_KEY]: handler,
});

export const readConfig = (config: Record<string, () => void>): (() => void) | undefined =>
  config[OPERATION_KEY];

export const readConfigOptional = (
  config: Record<string, () => void> | undefined,
): (() => void) | undefined => config?.[OPERATION_KEY];

/** Well-known symbol protocol implementations. */
export class Bag implements Iterable<string>, AsyncIterable<string> {
  readonly values: readonly string[] = [];

  [Symbol.iterator](): Iterator<string> {
    return this.values[Symbol.iterator]();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    yield* this.values;
  }

  get [Symbol.toStringTag](): string {
    return 'Bag';
  }
}

/** Declaring and *using* a symbol without slotting a capability behind it is fine. */
const registry = new Map<symbol, () => void>();
export const register = (handler: () => void): void => {
  registry.set(registryToken, handler);
};
export const describe = (): string | undefined => registryToken.description;

/** `[key: symbol]: true` is a marker table, not an operation record. */
export interface BrandTable {
  readonly [marker: symbol]: true;
}

/** A string index signature is not in scope at all. */
export interface HandlerTable {
  readonly [name: string]: () => void;
}

/** A nested shadow must win over the program-scope symbol. */
export const shadowed = (): Record<string, number> => {
  const registryToken = 'count';
  return { [registryToken]: 1 };
};

/** Template-literal and dynamic computed keys are not identifiers. */
export const dynamic = (prefix: string, handler: () => void): Record<string, () => void> => ({
  [`${prefix}:handler`]: handler,
});
