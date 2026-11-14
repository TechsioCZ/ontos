import { Schema } from 'effect';

export class MarketSearchUnavailable extends Schema.TaggedError<MarketSearchUnavailable>()('MarketSearchUnavailable', {
  code: Schema.Literal('market_search_unavailable'),
  reason: Schema.String,
}) {}

export const marketSearchUnavailable = (cause?: unknown) => {
  const error = new MarketSearchUnavailable({
    code: 'market_search_unavailable',
    reason: 'Market search projection is temporarily unavailable',
  });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { configurable: true, value: cause });
};
