import { Context, Effect } from 'effect';

export interface FeatureFlagResolverPort {
  readonly enabled: (key: string) => Effect.Effect<boolean, Error>;
}

/** The tag construction is wrapped in a `satisfies` expression before it reaches its binding. */
export const FeatureFlagResolver = Context.GenericTag<FeatureFlagResolverPort>(
  '@app/shell-super-app/api/FeatureFlagResolver',
) satisfies unknown;
