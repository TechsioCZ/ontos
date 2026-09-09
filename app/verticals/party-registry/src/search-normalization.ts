import { Effect, Match } from 'effect';

import { PartySearchProjectionUnavailable } from '../shared/domain/search-projection-error.ts';
import type { SearchNormalizationResult } from '../shared/domain/search-semantics.ts';

export const resolveSearchNormalization = <Result>(normalized: SearchNormalizationResult<Result>) =>
  Match.value(normalized).pipe(
    Match.tag('SearchResults', ({ items }) => Effect.succeed(items)),
    Match.tag('SearchProjectionViolation', ({ reason }) =>
      Effect.fail(
        new PartySearchProjectionUnavailable({
          code: 'party_search_projection_unavailable',
          reason,
        }),
      ),
    ),
    Match.exhaustive,
  );
