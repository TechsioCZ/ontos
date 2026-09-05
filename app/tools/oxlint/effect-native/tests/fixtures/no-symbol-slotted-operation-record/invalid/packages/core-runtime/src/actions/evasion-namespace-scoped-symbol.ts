// expect-count: 2
// Evasion: the identical slot, with the `unique symbol` declared one level in — inside a
// `namespace` block instead of directly in the program body.
export namespace ActionSlots {
  export const handler: unique symbol = Symbol('@app/core-runtime/actions/registration/handler');

  export interface Registration<Payload> {
    readonly [handler]: (payload: Payload) => Promise<void>;
  }

  export const register = <Payload>(
    operation: (payload: Payload) => Promise<void>,
  ): Registration<Payload> => ({ [handler]: operation });
}
