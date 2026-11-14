import { Schema } from 'effect';

export class SearchProjectionUnavailable extends Schema.TaggedError<SearchProjectionUnavailable>()(
  'AgreementsSearchProjectionUnavailable',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    code: Schema.Literal('agreements_search_projection_unavailable'),
    reason: Schema.String,
  },
) {}
export const searchUnavailable = (cause?: unknown) =>
  new SearchProjectionUnavailable({
    cause,
    code: 'agreements_search_projection_unavailable',
    reason: 'Agreements search projection is temporarily unavailable',
  });
