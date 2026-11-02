import { Schema } from 'effect';

/** A Market retirement intent that is not yet terminal; Core retries the delivery with backoff. */
export class MarketRetirementWorkerPending extends Schema.TaggedError<MarketRetirementWorkerPending>()(
  'MarketRetirementWorkerPending',
  {
    code: Schema.Literals(['market_retirement_pending', 'market_retirement_intent_invalid']),
    reason: Schema.String,
  },
) {}
