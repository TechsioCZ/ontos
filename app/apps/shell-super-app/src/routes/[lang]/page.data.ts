/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- The loader composes typed Effect callbacks until the single runtime boundary. */
import { activeModules, currentSession, runEffectRequest } from '../../api/auth-client.ts';
import type { ActiveModulesClientError } from '../../api/auth-client.ts';
import { Effect } from 'effect';
import { shellAuthenticationApiContract } from '../../../shared/api.ts';
import type { ActiveModules, SafeAuthenticatedIdentity } from '../../../shared/api.ts';

interface HomeLoaderArguments {
  readonly request: Request;
}

export interface AnonymousHomePageModel {
  readonly state: 'anonymous';
}

export interface AuthenticatedHomePageModel {
  readonly activeModules:
    | { readonly items: ActiveModules; readonly state: 'available' }
    | { readonly items: readonly []; readonly state: 'unavailable' };
  readonly identity: SafeAuthenticatedIdentity;
  readonly state: 'authenticated';
}

export type HomePageModel = AnonymousHomePageModel | AuthenticatedHomePageModel;

const anonymousModel: AnonymousHomePageModel = {
  state: 'anonymous',
};

const unavailableModules = (_error: ActiveModulesClientError) => ({
  items: [] as const,
  state: 'unavailable' as const,
});

export const loader = ({ request }: HomeLoaderArguments): Promise<HomePageModel> => {
  const cookie = request.headers.get('cookie');
  const options = {
    baseUrl: new URL(shellAuthenticationApiContract.apiPrefix, request.url),
    ...(cookie === null ? {} : { cookie }),
  };

  return runEffectRequest(
    currentSession(options).pipe(
      Effect.flatMap((session) =>
        session.state === 'anonymous'
          ? Effect.succeed<HomePageModel>(anonymousModel)
          : activeModules(options).pipe(
              Effect.map(
                (items): HomePageModel => ({
                  activeModules: { items, state: 'available' },
                  identity: session.identity,
                  state: 'authenticated',
                }),
              ),
              Effect.catch((error) =>
                Effect.succeed<HomePageModel>({
                  activeModules: unavailableModules(error),
                  identity: session.identity,
                  state: 'authenticated',
                }),
              ),
            ),
      ),
      Effect.catch(() => Effect.succeed<HomePageModel>(anonymousModel)),
    ),
  );
};
