// expect-count: 1
import { Effect, pipe } from 'effect';

/**
 * Same B4 option bag as `makeShellComposition`, written point-free: `pipe(value, ...)` instead of
 * `value.pipe(...)`. The dependency bag and the Effect body are unchanged.
 */
export const makeGatewayRuntime = (dependencies: GatewayRuntimeDependencies) =>
  pipe(
    Effect.succeed(dependencies),
    Effect.map((value) => value.issuer),
    Effect.tap((issuer) => Effect.logInfo(issuer)),
  );

export const createGatewayKey = (tenant: string, issuer: string) => `${tenant}:${issuer}`;
