const Effect = await import('effect/Effect');
const Library = await import('effect');
type Port = { runPromise(value: number): number };
export function fakeNamespace(Effect: Port) { return Effect.runPromise(1); }
export function fakeRoot(Library: { Effect: Port }) { return Library.Effect.runPromise(1); }
