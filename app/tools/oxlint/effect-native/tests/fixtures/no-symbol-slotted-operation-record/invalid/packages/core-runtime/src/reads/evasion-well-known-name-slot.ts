// expect-count: 4
// Evasion: the slot symbols are simply *named* like well-known symbols. `search` and `dispose`
// are ordinary domain words for a read registration, but they are neither `Symbol.search` nor
// `Symbol.dispose` — they are hand-rolled `unique symbol` capability slots, exactly B4.
const search: unique symbol = Symbol('@app/core-runtime/reads/registration/search');
const dispose: unique symbol = Symbol('@app/core-runtime/reads/registration/dispose');

export interface ReadRegistration<Input, Result> {
  readonly [dispose]: () => void;
  readonly [search]: (input: Input) => Result;
}

export const registerRead = <Input, Result>(
  handler: (input: Input) => Result,
  teardown: () => void,
): ReadRegistration<Input, Result> =>
  Object.freeze({
    [dispose]: teardown,
    [search]: handler,
  });
