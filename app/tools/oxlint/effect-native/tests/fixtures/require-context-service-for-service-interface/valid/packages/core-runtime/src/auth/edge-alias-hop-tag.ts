import { Context, Effect } from 'effect';

export interface ApiTokenRepositoryContract {
  readonly issue: (principalId: string) => Effect.Effect<string, Error>;
}

/** The tag names the contract through a one-hop local alias, exactly as the factory hop does. */
type ApiTokenRepositoryShape = ApiTokenRepositoryContract;

export class ApiTokenRepository extends Context.Service<
  ApiTokenRepository,
  ApiTokenRepositoryShape
>()('@app/core-runtime/auth/ApiTokenRepository') {}
