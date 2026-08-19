/* eslint-disable no-nested-ternary, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, unicorn/no-nested-ternary -- The closed client error union maps directly to one serializable route state. */
import { Effect } from 'effect';
import type { ResourceRef, ShellResourceResponse } from '../../../../../../../shared/api.ts';
import { shellAuthenticationApiContract } from '../../../../../../../shared/api.ts';
import { resourceDetail, runEffectRequest } from '../../../../../../api/auth-client.ts';
import { loadHomePageModel } from '../../../../page.data.ts';
import type { HomePageModel } from '../../../../page.data.ts';

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

interface ResourceLoaderArguments {
  readonly params: ResourceRef;
  readonly request: Request;
}

export type ResourcePageModel =
  | {
      readonly shell: HomePageModel;
      readonly state: 'forbidden' | 'not_found' | 'selection_required' | 'unavailable';
    }
  | {
      readonly resource: ShellResourceResponse;
      readonly shell: HomePageModel;
      readonly state: 'ready';
    };

export const loader = async ({ params, request }: ResourceLoaderArguments) => {
  const shell = await loadHomePageModel(request);
  if (shell.state !== 'authenticated') {
    return {
      shell,
      state: shell.state === 'unavailable' ? 'unavailable' : 'selection_required',
    } as const;
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
    resourceDetail(params, options).pipe(
      Effect.map((resource): ResourcePageModel => ({ resource, shell, state: 'ready' })),
      Effect.catch((error) =>
        Effect.succeed<ResourcePageModel>({
          shell,
          state:
            error._tag === 'ShellTargetForbiddenProblem'
              ? 'forbidden'
              : error._tag === 'ShellTargetNotFoundProblem'
                ? 'not_found'
                : error._tag === 'ShellSelectionRequiredProblem' ||
                    error._tag === 'ShellAuthenticationRequiredProblem'
                  ? 'selection_required'
                  : 'unavailable',
        }),
      ),
    ),
  );
};
