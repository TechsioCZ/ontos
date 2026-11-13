import { CoreSearchPresentationGroupKeySchema } from '@app/core-runtime/search-contract';
import { Effect, Match, Option, Predicate, Schema } from 'effect';
import type { Config } from 'effect';
import { Url, UrlParams } from 'effect/http';

import type { ShellSearchResponse } from '../../../../shared/api.ts';
import { searchResources } from '../../../api/auth-client.ts';
import type { ShellSearchClientError, ShellAuthenticationClientOptions } from '../../../api/auth-client.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { planShellSearchFilters } from '../../shell-search-match.ts';
import type { ShellSearchFilterPlan as SearchFilterPlan } from '../../shell-search-match.ts';
import { shellSearchPresentationIndex } from '../../shell-search-resource-types.ts';
import type { ShellSearchPresentationIndex } from '../../shell-search-resource-types.ts';
import {
  isServerRender,
  shellAuthenticationClientOptionsFromRequest,
} from '../../shell-authentication-client-options.ts';
import { loadHomePageModel, sessionEndedModel } from '../home-page-model.ts';
import { requireSignedIn } from '../../sign-in-return.ts';
import type { HomePageModel } from '../home-page-model.ts';

interface SearchLoaderArguments {
  readonly request: Request;
}

export type { ShellSearchFamilyAvailability as SearchFamilyAvailability } from '../../shell-search-match.ts';
export type { ShellSearchFilterPlan as SearchFilterPlan } from '../../shell-search-match.ts';
export type SearchPageModel =
  | {
      readonly query: string;
      readonly shell: HomePageModel;
      /** The server render sends the page without results; the browser runs the search after hydration. */
      readonly state: 'pending' | 'reload_required' | 'selection_required' | 'unavailable';
    }
  | {
      readonly filters: SearchFilterPlan;
      readonly index?: ShellSearchPresentationIndex;
      readonly query: string;
      readonly response: ShellSearchResponse;
      readonly shell: HomePageModel;
      readonly state: 'ready';
    };

const SearchRouteSearch = Schema.Struct({
  families: Schema.optionalKey(Schema.String),
  q: Schema.optionalKey(Schema.String),
});

interface SearchRouteSearchInput {
  families?: string;
  q?: string;
}

const SearchFamilyKeySchema = CoreSearchPresentationGroupKeySchema;

/**
 * The URL carries only bounded family keys; the validated inventory decides which of them exist. A present but
 * malformed key is kept verbatim so an invalid nonempty filter stays an unresolved selection instead of silently
 * widening to an unfiltered answer; the plan never matches it against the inventory.
 */
export const searchFamiliesFromValue = (value?: string): readonly string[] => {
  if (value === undefined) {
    return [];
  }
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const keys = parts.flatMap((part) => {
    const decoded = Schema.decodeUnknownOption(SearchFamilyKeySchema)(part);
    return Option.isSome(decoded) ? [decoded.value] : [part];
  });
  return [...new Set(keys)];
};

const searchFromRequest = (request: Request): typeof SearchRouteSearch.Type => {
  const params = Url.urlParams(new URL(request.url));
  const q = UrlParams.getFirst(params, 'q');
  const families = UrlParams.getFirst(params, 'families');
  const raw: SearchRouteSearchInput = {};
  if (Option.isSome(families)) {
    raw.families = families.value;
  }
  if (Option.isSome(q)) {
    raw.q = q.value;
  }
  return Option.getOrElse(Schema.decodeOption(SearchRouteSearch)(raw), () => ({}));
};

const readyModel = (
  shell: Extract<HomePageModel, { readonly state: 'authenticated' }>,
  query: string,
  response: ShellSearchResponse,
  filters: SearchFilterPlan,
  index?: ShellSearchPresentationIndex,
): SearchPageModel => {
  const model = { filters, query, response, shell, state: 'ready' as const };
  return index === undefined ? model : { ...model, index };
};

type AuthenticatedShell = Extract<HomePageModel, { readonly state: 'authenticated' }>;

export const searchReadyModel = ({
  compositionRevision,
  options,
  query,
  requestedFamilies,
  shell,
}: {
  readonly compositionRevision: string;
  readonly options: ShellAuthenticationClientOptions;
  readonly query: string;
  readonly requestedFamilies: readonly string[];
  readonly shell: AuthenticatedShell;
}): Effect.Effect<SearchPageModel, ShellSearchClientError> => {
  // An empty selection means the URL asked for no filter: one real unfiltered request carrying its own inventory.
  if (requestedFamilies.length === 0) {
    return searchResources({ compositionRevision, query }, options).pipe(
      Effect.flatMap((unfiltered) => {
        const index = shellSearchPresentationIndex(unfiltered.presentation, compositionRevision);
        const plan = planShellSearchFilters({ index, partial: unfiltered.partial, requestedFamilies: [] });
        return Effect.succeed(readyModel(shell, query, unfiltered, plan, index));
      }),
    );
  }
  // A family filter can only name exact owner types after the admitted inventory arrives, so the first request asks
  // for the inventory alone (an explicit empty selector, zero owner dispatch) and only the second asks the selected
  // types. An unknown, malformed or unresolved selection stays empty and never widens to the unfiltered answer.
  return searchResources({ compositionRevision, query, resourceTypes: [] }, options).pipe(
    Effect.flatMap((inventory) => {
      const index = shellSearchPresentationIndex(inventory.presentation, compositionRevision);
      const plan = planShellSearchFilters({ index, partial: inventory.partial, requestedFamilies });
      if (plan.resourceTypes === undefined || plan.resourceTypes.length === 0) {
        const response: ShellSearchResponse =
          inventory.presentation === undefined
            ? { partial: inventory.partial, results: [] }
            : { partial: inventory.partial, presentation: inventory.presentation, results: [] };
        return Effect.succeed(readyModel(shell, query, response, plan, index));
      }
      return searchResources({ compositionRevision, query, resourceTypes: plan.resourceTypes }, options).pipe(
        Effect.map((filtered) =>
          // The inventory index stays canonical: a filtered answer carries only the selected families, so keeping
          // the inventory keeps every declared family selectable instead of shrinking the filter row.
          readyModel(
            shell,
            query,
            filtered,
            plan,
            index ?? shellSearchPresentationIndex(filtered.presentation, compositionRevision),
          ),
        ),
      );
    }),
  );
};

/** The honest page state for a failed fresh search; the previous answer is never kept. */
export const searchFailureModel = (
  error: ShellSearchClientError | Config.ConfigError,
  shell: AuthenticatedShell,
  query: string,
): SearchPageModel => ({
  query,
  // The search read itself saying "sign in again" means the session died meanwhile.
  shell: Predicate.isTagged(error, 'ShellAuthenticationRequiredProblem') ? sessionEndedModel : shell,
  state: Match.value(error).pipe(
    Match.tag('ShellReloadRequiredProblem', () => 'reload_required' as const),
    Match.tag(
      'ShellAuthenticationRequiredProblem',
      'ShellSelectionRequiredProblem',
      () => 'selection_required' as const,
    ),
    Match.tag(
      'ConfigError',
      'HttpClientError',
      'SchemaError',
      'ShellCapabilityUnavailableProblem',
      'ShellInternalProblem',
      'ShellInvalidRequestProblem',
      'ShellPolicyConflictProblem',
      'ShellPolicyUnprocessableProblem',
      'ShellPreconditionRequiredProblem',
      'ShellRateLimitedProblem',
      'ShellTargetForbiddenProblem',
      'ShellTargetNotFoundProblem',
      () => 'unavailable' as const,
    ),
    Match.exhaustive,
  ),
});

export const loader = ({ request }: SearchLoaderArguments): Promise<SearchPageModel> => {
  const search = searchFromRequest(request);
  const query = (search.q ?? '').trim();
  const requestedFamilies = searchFamiliesFromValue(search.families);
  return browserRuntime
    .runPromise(
      loadHomePageModel(request).pipe(
        Effect.timeout('30 seconds'),
        Effect.flatMap((shell) => {
          if (shell.state !== 'authenticated') {
            return Effect.succeed<SearchPageModel>({
              query,
              shell,
              state: shell.state === 'anonymous' ? 'selection_required' : shell.state,
            });
          }
          if (shell.compositionRevision === undefined) {
            return Effect.succeed<SearchPageModel>({
              query,
              shell,
              state: 'selection_required',
            });
          }
          const { compositionRevision } = shell;
          if (query.length === 0) {
            return Effect.succeed<SearchPageModel>(
              readyModel(
                shell,
                query,
                { partial: false, results: [] },
                {
                  availableFamilies: [],
                  selectedFamilies: [],
                },
              ),
            );
          }
          // The search fans out to every module and waits for the slowest one, and the page is not indexable. Keep it
          // out of the server render so the document is sent at once; the browser loader answers it after hydration.
          if (isServerRender()) {
            return Effect.succeed<SearchPageModel>({ query, shell, state: 'pending' });
          }
          return shellAuthenticationClientOptionsFromRequest(request).pipe(
            Effect.flatMap((options) =>
              searchReadyModel({ compositionRevision, options, query, requestedFamilies, shell }),
            ),
            Effect.matchEffect({
              onFailure: (error) => Effect.succeed<SearchPageModel>(searchFailureModel(error, shell, query)),
              onSuccess: Effect.succeed,
            }),
          );
        }),
      ),
      { signal: request.signal },
    )
    .then((model) => requireSignedIn(request, model));
};
