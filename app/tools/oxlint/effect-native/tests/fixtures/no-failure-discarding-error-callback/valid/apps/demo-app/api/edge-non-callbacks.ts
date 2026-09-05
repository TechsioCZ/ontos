// Degenerate and non-callback arguments: the rule must stay quiet and must not crash.
import { Effect } from 'effect';

class Unavailable {}
declare const load: Effect.Effect<number, Error>;
declare const spreadArguments: readonly [() => Unavailable];
declare const options: { readonly try: () => number; readonly catch: () => Unavailable };
declare const key: string;
const table = { unavailable: () => new Unavailable() };
enum Kind {
  A = 1,
}

export const noArguments = Effect.mapError();
export const spread = Effect.mapError(...spreadArguments);
export const classReference = load.pipe(Effect.mapError(Unavailable));
export const enumMember = load.pipe(Effect.orElseFail(Kind.A as unknown as () => Unavailable));
export const memberCallback = load.pipe(Effect.mapError(table.unavailable));
export const optionsIdentifier = Effect.try(options);
export const singleArgumentTry = Effect.try(() => 1);
export const dynamicMember = (Effect as unknown as Record<string, (f: () => Unavailable) => unknown>)[key](
  () => new Unavailable(),
);
export const tagged = Effect.mapError`not a call with arguments`;
export const emptyOptions = Effect.tryPromise({ try: () => Promise.resolve(1) });
