// expect-count: 3
// Partial dictionaries retain the optional environment-string shape after total maps are excluded.
export function parsePartial(values: Partial<Record<string, string>>): string {
  throw new Error(values.PORT);
}
export function parseReadonly(values: Readonly<Partial<Record<string, string>>>): string {
  throw new Error(values.PORT);
}
// A local object called Effect is not an imported Effect boundary.
export function parseShadowedEffect(environment: NodeJS.ProcessEnv): unknown {
  const Effect = { sync: (callback: () => unknown) => callback() };
  return Effect.sync(() => { throw new Error(environment.PORT); });
}
