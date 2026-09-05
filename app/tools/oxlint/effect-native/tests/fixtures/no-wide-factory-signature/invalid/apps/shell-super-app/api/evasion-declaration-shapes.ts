// expect-count: 12
/** Every declaration form that can name a factory, each holding the same wide positional shape. */

export class ShellRegistry {
  /** 1. class method */
  makeShellRuntime(database: unknown, gateway: unknown, resolver: unknown) {
    return { database, gateway, resolver };
  }

  /** 2. static class field holding an arrow */
  static createShellGateway = (database: unknown, gateway: unknown, resolver: unknown, clock: unknown) => ({
    clock,
    database,
    gateway,
    resolver,
  });

  /** Allowed: within the limit. */
  createShellKey(tenant: string, module: string) {
    return `${tenant}:${module}`;
  }
}

/** 3. generator function declaration */
export function* makeShellStream(database: unknown, gateway: unknown, resolver: unknown) {
  yield { database, gateway, resolver };
}

/** 4. async generator function declaration */
export async function* makeShellFeed(database: unknown, gateway: unknown, resolver: unknown) {
  yield { database, gateway, resolver };
}

/** 5. `as` wrapper between the arrow and the declarator */
export const makeShellPorts = ((database: unknown, gateway: unknown, resolver: unknown) => ({
  database,
  gateway,
  resolver,
})) as ShellPortsFactory;

/** 6. `satisfies` wrapper */
export const createShellPorts = ((database: unknown, gateway: unknown, resolver: unknown) => ({
  database,
  gateway,
  resolver,
})) satisfies ShellPortsFactory;

/** 7. assignment to a named member */
export const shellRegistry: Record<string, unknown> = {};
shellRegistry.makeShellCache = (database: unknown, gateway: unknown, resolver: unknown) => ({
  database,
  gateway,
  resolver,
});

/** 8. abstract class method — the port shape, no body */
export abstract class ShellBase {
  abstract makeBaseRuntime(database: unknown, gateway: unknown, resolver: unknown): unknown;
  abstract createBaseKey(tenant: string, module: string): string;
}

/** 9. ambient declaration */
export declare function makeAmbientRuntime(database: unknown, gateway: unknown, resolver: unknown): unknown;

/** 10 + 11. overload signature and its implementation both fix the positional shape */
export function makeOverloadedRuntime(database: unknown): unknown;
export function makeOverloadedRuntime(database: unknown, gateway: unknown, resolver: unknown): unknown;
export function makeOverloadedRuntime(database: unknown, gateway?: unknown, resolver?: unknown): unknown {
  return { database, gateway, resolver };
}

/** 12. nested inside another function body — the outer arrow takes no parameters at all */
export const createShellComposition = () => {
  const makeInnerRuntime = (database: unknown, gateway: unknown, resolver: unknown) => ({
    database,
    gateway,
    resolver,
  });
  return makeInnerRuntime;
};
