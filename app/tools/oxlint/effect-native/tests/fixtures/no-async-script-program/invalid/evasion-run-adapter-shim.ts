// expect-count: 2
// A hand-rolled object merely *named* like a runtime is not `Effect.run*` and is not a
// captured ManagedRuntime, so these module-level awaits are plain Promise-program awaits.
export {};

declare const connect: () => Promise<void>;

const shim = { runPromise: <A,>(promise: Promise<A>): Promise<A> => promise };

await shim.runPromise(connect());
await shim["runSync"](connect());
