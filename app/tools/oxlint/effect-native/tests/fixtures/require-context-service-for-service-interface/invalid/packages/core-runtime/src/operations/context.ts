// expect-count: 1
import { Context as Ctx, Effect } from 'effect';

/** Audit B4 evidence (`packages/core-runtime/src/operations/context.ts`), with an aliased namespace. */
export interface OperationalScopeRepository {
  readonly load: (principalId: string) => Effect.Effect<string, Error>;
}

export interface OperationalScopeResolverService {
  readonly resolve: (principalId: string) => Effect.Effect<string, Error>;
}

export class OperationalScopeResolver extends Ctx.Service<
  OperationalScopeResolver,
  OperationalScopeResolverService
>()('@app/core-runtime/operations/OperationalScopeResolver') {}
