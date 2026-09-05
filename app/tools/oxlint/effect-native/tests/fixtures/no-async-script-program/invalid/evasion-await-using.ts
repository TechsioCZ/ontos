// expect-count: 1
// `await using` is a module-level await: the implicit async disposal runs during module
// evaluation with no fiber, no Scope and no error channel — exactly what `Scope` owns.
export {};

declare const open: () => AsyncDisposable & { read: () => string };

await using handle = open();

console.log(handle.read());
