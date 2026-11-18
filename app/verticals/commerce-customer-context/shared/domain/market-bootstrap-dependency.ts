import { Schema } from 'effect';

export class MarketBootstrapDependencyUnavailable extends Schema.TaggedError<MarketBootstrapDependencyUnavailable>()(
  'MARKET_BOOTSTRAP_DEPENDENCY_UNAVAILABLE',
  {
    dependency: Schema.Literals(['MARKET', 'POLICY']),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
