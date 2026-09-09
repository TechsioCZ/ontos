import { Effect, Match, Option, Schema } from 'effect';
import { Url, UrlParams } from 'effect/unstable/http';

import type { ShellSearchResponse } from '../../../../shared/api.ts';
import { searchResources } from '../../../api/auth-client.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../shell-authentication-client-options.ts';
import { loadHomePageModel } from '../page.data.ts';
import type { HomePageModel } from '../page.data.ts';

interface SearchLoaderArguments {
  readonly request: Request;
}

export type SearchPageModel =
  | {
      readonly query: string;
      readonly shell: HomePageModel;
      readonly state: 'selection_required' | 'unavailable';
    }
  | {
      readonly query: string;
      readonly response: ShellSearchResponse;
      readonly shell: HomePageModel;
      readonly state: 'ready';
    };

export const SearchRouteSearch = Schema.Struct({
  q: Schema.optionalKey(Schema.String),
});
export const SearchRouteSearchStandard = Schema.toStandardSchemaV1(SearchRouteSearch);

const searchFromRequest = (request: Request): typeof SearchRouteSearch.Type => {
  const query = UrlParams.getFirst(Url.urlParams(new URL(request.url)), 'q');
  return Option.getOrElse(
    Schema.decodeOption(SearchRouteSearch)(Option.isSome(query) ? { q: query.value } : {}),
    () => ({}),
  );
};

export const loader = ({ request }: SearchLoaderArguments): Promise<SearchPageModel> => {
  const query = (searchFromRequest(request).q ?? '').trim();
  return browserRuntime.runPromise(
    loadHomePageModel(request).pipe(
      Effect.timeout('30 seconds'),
      Effect.flatMap((shell) => {
        if (shell.state !== 'authenticated') {
          return Effect.succeed<SearchPageModel>({
            query,
            shell,
            state: shell.state === 'unavailable' ? 'unavailable' : 'selection_required',
          });
        }
        if (shell.contextState !== 'authenticated') {
          return Effect.succeed<SearchPageModel>({
            query,
            shell,
            state: 'selection_required',
          });
        }
        if (query.length === 0) {
          return Effect.succeed<SearchPageModel>({
            query,
            response: { partial: false, results: [] },
            shell,
            state: 'ready',
          });
        }
        return shellAuthenticationClientOptionsFromRequest(request).pipe(
          Effect.flatMap((options) => searchResources({ query }, options)),
          Effect.map((response): SearchPageModel => ({
            query,
            response,
            shell,
            state: 'ready',
          })),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.succeed<SearchPageModel>({
                query,
                shell,
                state: Match.value(error).pipe(
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
  );
};
