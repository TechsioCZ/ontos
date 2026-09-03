/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- The loader preserves the typed Effect error channel until the framework boundary. */
import { Effect } from 'effect';
import type { ShellSearchResponse } from '../../../../shared/api.ts';
import { runEffectRequest, searchResources } from '../../../api/auth-client.ts';
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

export const loader = ({ request }: SearchLoaderArguments): Promise<SearchPageModel> => {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim() ?? '';
  return runEffectRequest(
    Effect.promise(() => loadHomePageModel(request)).pipe(
      Effect.flatMap((shell) => {
        if (shell.state !== 'authenticated') {
          return Effect.succeed<SearchPageModel>({
            query,
            shell,
            state: shell.state === 'unavailable' ? 'unavailable' : 'selection_required',
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
          Effect.flatMap((options) => {
            const includeArchived = url.searchParams.get('includeArchived') === 'true';
            const role = url.searchParams.get('role');
            if (role === 'CUSTOMER' || role === 'SUPPLIER') {
              return searchResources(
                includeArchived ? { includeArchived: true, query, role } : { query, role },
                options,
              );
            }
            return searchResources(
              includeArchived ? { includeArchived: true, query } : { query },
              options,
            );
          }),
          Effect.map((response): SearchPageModel => ({ query, response, shell, state: 'ready' })),
          Effect.catch((error) =>
            Effect.succeed<SearchPageModel>({
              query,
              shell,
              state:
                error._tag === 'ShellSelectionRequiredProblem' ||
                error._tag === 'ShellAuthenticationRequiredProblem'
                  ? 'selection_required'
                  : 'unavailable',
            }),
          ),
        );
      }),
    ),
  );
};
