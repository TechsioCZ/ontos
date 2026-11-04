import { Effect, Match, Option, Predicate, Schema } from 'effect';
import { Url, UrlParams } from 'effect/http';

import type { ShellSearchResponse, ShellSearchResult } from '../../../../shared/api.ts';
import { searchResources } from '../../../api/auth-client.ts';
import type { ShellSearchClientError, ShellAuthenticationClientOptions } from '../../../api/auth-client.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import {
  shellSearchFamiliesInOrder,
  shellSearchFamilyKeys,
  shellSearchFamilyOfGroup,
  shellSearchGroupsOfFamilies,
  shellSearchGroupsOfFamily,
} from '../../shell-search-match.ts';
import type { ShellSearchFamilyKey } from '../../shell-search-match.ts';
import {
  shellSearchGroupOf,
  shellSearchPresentationContext,
  shellSearchResourceTypesForGroups,
} from '../../shell-search-resource-types.ts';
import type { ShellSearchGroupKey } from '../../shell-search-resource-types.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../shell-authentication-client-options.ts';
import { loadHomePageModel, sessionEndedModel } from '../home-page-model.ts';
import { requireSignedIn } from '../../sign-in-return.ts';
import type { HomePageModel } from '../home-page-model.ts';

interface SearchLoaderArguments {
  readonly request: Request;
}

type ShellSearchContext = ReturnType<typeof shellSearchPresentationContext>;

/** A record family that has at least one exact registered type in the current authorized answer. */
export interface SearchFamilyAvailability {
  readonly groups: readonly ShellSearchGroupKey[];
  readonly key: ShellSearchFamilyKey;
}

export interface SearchFilterPlan {
  readonly availableFamilies: readonly SearchFamilyAvailability[];
  /** Absent omits the field; an empty list is the server's explicit "no type". */
  readonly resourceTypes?: readonly string[];
  readonly selectedFamilies: readonly ShellSearchFamilyKey[];
}

export type SearchPageModel =
  | {
      readonly query: string;
      readonly shell: HomePageModel;
      readonly state: 'reload_required' | 'selection_required' | 'unavailable';
    }
  | {
      readonly filters: SearchFilterPlan;
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

const SearchFamilyKeySchema = Schema.Literals(shellSearchFamilyKeys);

const familiesFromValue = (value: string | undefined): readonly ShellSearchFamilyKey[] => {
  if (value === undefined) {
    return [];
  }
  const decoded = Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Array(SearchFamilyKeySchema))(value.split(',').map((part) => part.trim())),
    (): readonly ShellSearchFamilyKey[] => [],
  );
  return [...new Set(decoded)];
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

/**
 * The filter plan for one complete authorized answer. Available families are the families that actually appear in the
 * unfiltered result, and their request types are the registered types observed for those groups only. That keeps an
 * uninstalled module's registry key out of the payload and makes a selected filter a real server request, never a
 * filter over an answer already received. A partial answer offers no filter; the next fresh query derives a new plan.
 */
export const planShellSearchFilters = ({
  context,
  partial,
  requestedFamilies,
  results,
}: {
  readonly context: ShellSearchContext;
  readonly partial: boolean;
  readonly requestedFamilies: readonly ShellSearchFamilyKey[];
  readonly results: readonly ShellSearchResult[];
}): SearchFilterPlan => {
  const emptyPlan: SearchFilterPlan = { availableFamilies: [], selectedFamilies: [] };
  if (partial) {
    return emptyPlan;
  }
  const groupsByFamily = new Map<ShellSearchFamilyKey, Set<ShellSearchGroupKey>>();
  for (const result of results) {
    const group = shellSearchGroupOf(result, context);
    const family = shellSearchFamilyOfGroup(group);
    const groups = groupsByFamily.get(family) ?? new Set<ShellSearchGroupKey>();
    groups.add(group);
    groupsByFamily.set(family, groups);
  }
  const availableFamilies = shellSearchFamiliesInOrder([...groupsByFamily.keys()]).flatMap(
    (key): readonly SearchFamilyAvailability[] => {
      const observed = groupsByFamily.get(key);
      const groups = shellSearchGroupsOfFamily(key).filter((group) => observed?.has(group) === true);
      const resourceTypes = shellSearchResourceTypesForGroups(groups, results, context);
      return resourceTypes === undefined || resourceTypes.length === 0 ? [] : [{ groups, key }];
    },
  );
  const availableKeys = new Set(availableFamilies.map(({ key }) => key));
  const selectedFamilies = shellSearchFamiliesInOrder(requestedFamilies.filter((family) => availableKeys.has(family)));
  if (selectedFamilies.length === 0) {
    return { availableFamilies, selectedFamilies: [] };
  }
  const registered = shellSearchResourceTypesForGroups(shellSearchGroupsOfFamilies(selectedFamilies), results, context);
  if (registered === undefined) {
    return { availableFamilies, selectedFamilies: [] };
  }
  const observedTypes = new Set(results.map(({ ref }) => ref.resourceType));
  const resourceTypes = registered.filter((resourceType) => observedTypes.has(resourceType));
  return { availableFamilies, resourceTypes, selectedFamilies };
};

const readyModel = (
  shell: Extract<HomePageModel, { readonly state: 'authenticated' }>,
  query: string,
  response: ShellSearchResponse,
  filters: SearchFilterPlan,
): SearchPageModel => ({ filters, query, response, shell, state: 'ready' });

type AuthenticatedShell = Extract<HomePageModel, { readonly state: 'authenticated' }>;

const searchWithFilters = ({
  compositionRevision,
  options,
  query,
  requestedFamilies,
  shell,
}: {
  readonly compositionRevision: string;
  readonly options: ShellAuthenticationClientOptions;
  readonly query: string;
  readonly requestedFamilies: readonly ShellSearchFamilyKey[];
  readonly shell: AuthenticatedShell;
}): Effect.Effect<SearchPageModel, ShellSearchClientError> =>
  searchResources({ compositionRevision, query }, options).pipe(
    Effect.flatMap((unfiltered) => {
      const plan = planShellSearchFilters({
        context: shellSearchPresentationContext(shell.navigation.items),
        partial: unfiltered.partial,
        requestedFamilies,
        results: unfiltered.results,
      });
      if (plan.selectedFamilies.length === 0 || plan.resourceTypes === undefined) {
        return Effect.succeed(readyModel(shell, query, unfiltered, plan));
      }
      if (plan.resourceTypes.length === 0) {
        // The server's explicit empty type list: no owner call is needed and the answer is empty.
        return Effect.succeed(readyModel(shell, query, { partial: false, results: [] }, plan));
      }
      return searchResources({ compositionRevision, query, resourceTypes: plan.resourceTypes }, options).pipe(
        Effect.map((filtered) => readyModel(shell, query, filtered, plan)),
      );
    }),
  );

export const loader = ({ request }: SearchLoaderArguments): Promise<SearchPageModel> => {
  const search = searchFromRequest(request);
  const query = (search.q ?? '').trim();
  const requestedFamilies = familiesFromValue(search.families);
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
          if (shell.contextState !== 'authenticated' || shell.compositionRevision === undefined) {
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
          return shellAuthenticationClientOptionsFromRequest(request).pipe(
            Effect.flatMap((options) =>
              searchWithFilters({ compositionRevision, options, query, requestedFamilies, shell }),
            ),
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.succeed<SearchPageModel>({
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
                }),
              onSuccess: Effect.succeed,
            }),
          );
        }),
      ),
      { signal: request.signal },
    )
    .then((model) => requireSignedIn(request, model));
};
