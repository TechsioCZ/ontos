import { Context, Effect, Layer } from 'effect';

/**
 * The tag is typed through the factory (`ReturnType<typeof make…>`), so both the alias and the
 * interface the factory declares as its return type are wired — neither is a positional seam.
 */
export interface ApiKeyServiceContract {
  readonly issue: (principalId: string) => Effect.Effect<string, Error>;
}

export const makeApiKeyService = (seed: string): ApiKeyServiceContract => ({
  issue: (principalId) => Effect.succeed(`${seed}:${principalId}`),
});

export type ApiKeyServiceAccess = ReturnType<typeof makeApiKeyService>;

export class ApiKeyService extends Context.Service<
  ApiKeyService,
  ReturnType<typeof makeApiKeyService>
>()('@app/core-runtime/auth/ApiKeyService') {}

export const ApiKeyServiceLive = Layer.succeed(ApiKeyService, makeApiKeyService('seed'));
