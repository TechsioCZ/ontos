// `@effect-diagnostics-next-line` is the Effect language service's LINE-scoped form (5 occurrences
// in @effect/language-service dist; documented alongside the file-wide `@effect-diagnostics`).
// Narrowing a file-wide waiver to it is exactly what this rule's own message asks for, so it must
// not be reported as a file-wide suppression.
// @effect-diagnostics-next-line asyncFunction:off
export const load = async (): Promise<number> => Promise.resolve(1);
