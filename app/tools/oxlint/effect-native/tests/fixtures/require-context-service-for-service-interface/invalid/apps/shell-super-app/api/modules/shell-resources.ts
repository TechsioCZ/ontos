// expect-count: 2
import { Context, Effect, Layer } from 'effect';

/**
 * Real shape of `apps/shell-super-app/api/modules/shell-resources.ts`: the module tags one contract
 * and leaves two Effect-returning provider gateways untagged, threaded positionally into factories.
 * A tag for a *different* contract must not launder its neighbours.
 */
export interface ShellSearchProviderGateway {
  readonly search: (appId: string) => Effect.Effect<readonly unknown[], Error>;
}

export interface ShellResourceProviderGateway {
  readonly detail: (appId: string) => Effect.Effect<unknown, Error>;
}

export interface ShellResourceServicesFactoryService {
  readonly createSearch: (gateway: ShellSearchProviderGateway) => Effect.Effect<string>;
}

export class ShellResourceServicesFactory extends Context.Service<
  ShellResourceServicesFactory,
  ShellResourceServicesFactoryService
>()('@app/shell-super-app/api/modules/ShellResourceServicesFactory') {}

export const ShellResourceServicesFactoryLive = Layer.succeed(ShellResourceServicesFactory, {
  createSearch: () => Effect.succeed('a'),
});
