/** The Effect-native target shape B4 asks for, plus every audit-blessed pattern nearby. */
import { Effect, Layer, Schema } from 'effect';

export type ActionHandler<Payload, Result> = (payload: Payload) => Effect.Effect<Result>;

/** Named, typed fields on a declared surface: nothing hidden behind a symbol. */
export interface ActionRegistration<Payload, Result> {
  readonly actionKey: string;
  readonly handler: ActionHandler<Payload, Result>;
  readonly serviceFactory: () => Effect.Effect<void>;
}

export const ActionRegistryLive = Layer.succeed('ActionRegistry', {
  lookup: (key: string) => Effect.succeed(key),
});

/** D tier: one outer process adapter seam, with `Layer.orDie` at a deliberate startup root. */
export const main = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.log('boot').pipe(Effect.provide(Layer.orDie(ActionRegistryLive))),
  );
};

/** Preserved: Schema-owned payloads and external fixture bodies that need a string. */
export const PayloadSchema = Schema.Struct({ id: Schema.String });
export const encodeFixtureBody = (value: { readonly id: string }): string => JSON.stringify(value);

/** Preserved: native array operations where Effect collection APIs add no semantic value. */
export const idsOf = (rows: readonly { readonly id: string }[]): readonly string[] =>
  rows.map((row) => row.id);

/** Well-known symbols implement a language protocol, not a hand-rolled capability slot. */
export class Bag implements Iterable<string> {
  readonly values: readonly string[] = [];

  [Symbol.iterator](): Iterator<string> {
    return this.values[Symbol.iterator]();
  }
}

/** A function-scope sentinel (`actions/runtime.ts` rollback token) is not a record slot. */
export const rollbackTokenOf = (): symbol => {
  const rollbackToken = Symbol('@app/core-runtime/actions/rollback');
  return rollbackToken;
};

const slot: unique symbol = Symbol('@app/shell/slot');

/** A nested shadow must not inherit the program-scope symbol's meaning. */
export const shadowed = (): Record<string, number> => {
  const slot = 'count';
  return { [slot]: 1 };
};

export interface RealSlot {
  readonly [slot]: true;
}
