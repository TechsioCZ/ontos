import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';

export interface PrincipalResolverService {
  readonly resolve: (id: string) => Effect.Effect<string, Error>;
}

/** Submodule namespace imports plus the `GenericTag` form. */
export const PrincipalResolver = Context.GenericTag<PrincipalResolverService>(
  '@app/shell-super-app/api/PrincipalResolver',
);
