// expect-count: 2
/** Computed but statically known names: the factory identity is still written in the source. */
export const registry: Record<string, unknown> = {};

registry['makeCacheRuntime'] = (
  database: unknown,
  gateway: unknown,
  resolver: unknown,
  clock: unknown,
) => ({ clock, database, gateway, resolver });

export const ports = {
  ['makeQueryRuntime']: (database: unknown, gateway: unknown, resolver: unknown, clock: unknown) => ({
    clock,
    database,
    gateway,
    resolver,
  }),
};
