// expect-count: 1
// `export * from "effect/Effect"` re-exports every run function, so an importing test gets the
// same ad hoc root fiber as a direct import.
export * from "effect/Effect";
