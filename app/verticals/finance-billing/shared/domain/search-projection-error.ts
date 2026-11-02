import { Schema } from 'effect';

export class SearchProjectionUnavailable extends Schema.TaggedError<SearchProjectionUnavailable>()(
  'FinanceSearchProjectionUnavailable',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    code: Schema.Literal('finance_search_projection_unavailable'),
    reason: Schema.String,
  },
) {}
export const searchUnavailable = (cause?: unknown) =>
  new SearchProjectionUnavailable({
    cause,
    code: 'finance_search_projection_unavailable',
    reason: 'Finance search projection is temporarily unavailable',
  });
