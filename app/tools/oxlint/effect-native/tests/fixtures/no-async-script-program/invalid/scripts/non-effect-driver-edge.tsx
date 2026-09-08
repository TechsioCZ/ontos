// expect-count: 4
// `Effect` here is a local object, not the `effect` package: it creates no driver edge.
const Effect = {
	promise: <A,>(thunk: () => Promise<A>): Promise<A> => thunk(),
	tryPromise: <A,>(options: { readonly try: () => Promise<A> }): Promise<A> => options.try(),
};

export const badPromise = Effect.promise(async () => 1);
export const badTry = Effect.tryPromise({ try: async () => 2 });

// A `try` property on some other library's retry helper is not a driver edge either.
declare const retry: <A>(options: { readonly try: () => Promise<A> }) => Promise<A>;
export const badRetry = retry({ try: async () => 3 });

// An async callback handed to a third-party API in a script is still an async program.
declare const emitter: { on: (event: string, handler: () => Promise<void>) => void };
emitter.on("drain", async () => {
	console.log("drained");
});
