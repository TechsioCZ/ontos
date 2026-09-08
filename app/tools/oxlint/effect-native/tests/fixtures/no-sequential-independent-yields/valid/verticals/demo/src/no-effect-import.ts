// No `effect` import at all: the rule never runs.
declare const alpha: { readonly read: () => Generator<unknown, string> };
declare const beta: { readonly read: () => Generator<unknown, string> };

export function* plain() {
  const first = yield* alpha.read();
  const second = yield* beta.read();
  return { first, second };
}
