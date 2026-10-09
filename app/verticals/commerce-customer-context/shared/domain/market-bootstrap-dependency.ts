import { Data } from 'effect';

export class MarketBootstrapDependencyUnavailable extends Data.TaggedError('MARKET_BOOTSTRAP_DEPENDENCY_UNAVAILABLE')<{
  readonly dependency: 'MARKET' | 'POLICY';
  readonly reason: string;
  readonly retryable: true;
}> {}
