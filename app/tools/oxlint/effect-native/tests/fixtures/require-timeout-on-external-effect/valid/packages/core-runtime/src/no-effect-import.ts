// No `effect` import at all: an `Effect`-named local is not the Effect module.
declare const Effect: { tryPromise: <A>(thunk: () => Promise<A>) => A };
declare const db: { read: () => Promise<string> };

export const value = Effect.tryPromise(() => db.read());
