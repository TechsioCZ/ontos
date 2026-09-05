// expect-count: 2
// Same-file aliases of the unshadowed global: the initialiser is statically the native constructor,
// so `new Native(...)` and `new Renamed(...)` construct native errors just like `new Error(...)`.
const Native = Error;

export const aliased = (): unknown => new Native("aliased through a local const");

const { TypeError: Renamed } = globalThis;

export const destructured = (): unknown => new Renamed("destructured off globalThis");
