/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- The loader preserves the typed Effect error channel until the framework boundary. */
import { Effect } from 'effect';
import type { ShellSearchResponse } from '../../../../shared/api.ts';
import { shellAuthenticationApiContract } from '../../../../shared/api.ts';
import { runEffectRequest, searchResources } from '../../../api/auth-client.ts';
import { loadHomePageModel } from '../page.data.ts';
import type { HomePageModel } from '../page.data.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

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

export const loader = async ({ request }: SearchLoaderArguments): Promise<SearchPageModel> => {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim() ?? '';
  const shell = await loadHomePageModel(request);
  if (shell.state !== 'authenticated') {
    return {
      query,
      shell,
      state: shell.state === 'unavailable' ? 'unavailable' : 'selection_required',
    };
  }
  if (shell.contextState !== 'authenticated') {
    return { query, shell, state: 'selection_required' };
  }
  if (query.length === 0) {
    return {
      query,
      response: { partial: false, results: [] },
      shell,
      state: 'ready',
    };
  }
  const cookie = request.headers.get('cookie');
  const options = withOptionalProperty(
    {
      baseUrl: new URL(shellAuthenticationApiContract.apiPrefix, request.url),
    },
    !(cookie === null),
    'cookie',
    cookie,
    {},
  );
  return runEffectRequest(
    searchResources({ query }, options).pipe(
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
    ),
  );
};
