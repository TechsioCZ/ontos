/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- The loader composes typed Effect callbacks until the single runtime boundary. */
import {
  activeModules,
  availableTenants,
  currentSession,
  runEffectRequest,
} from '../../api/auth-client.ts';
import type {
  ActiveModulesClientError,
  AvailableTenantsClientError,
} from '../../api/auth-client.ts';
import { Effect } from 'effect';
import { shellAuthenticationApiContract } from '../../../shared/api.ts';
import type {
  ActiveModules,
  AvailableTenant,
  SafeAuthenticatedIdentity,
} from '../../../shared/api.ts';

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
  readonly tenants:
    | { readonly items: readonly AvailableTenant[]; readonly state: 'available' }
    | { readonly items: readonly [AvailableTenant]; readonly state: 'unavailable' };
}

export type HomePageModel = AnonymousHomePageModel | AuthenticatedHomePageModel;

const anonymousModel: AnonymousHomePageModel = {
  state: 'anonymous',
};

const unavailableModules = (_error: ActiveModulesClientError) => ({
  items: [] as const,
  state: 'unavailable' as const,
});

const unavailableTenants = (tenantId: string) => ({
  items: [{ name: tenantId, tenantId }] as const,
  state: 'unavailable' as const,
});

const tenantRead = (error: AvailableTenantsClientError, tenantId: string) =>
  error._tag === 'TenantAuthenticationRequiredProblem'
    ? ({ state: 'stale' } as const)
    : unavailableTenants(tenantId);

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
          : Effect.all({
              activeModules: activeModules(options).pipe(
                Effect.map((items) => ({ items, state: 'available' as const })),
                Effect.catch((error) => Effect.succeed(unavailableModules(error))),
              ),
              tenants: availableTenants(options).pipe(
                Effect.map(({ tenants }) => ({ items: tenants, state: 'available' as const })),
                Effect.catch((error) =>
                  Effect.succeed(tenantRead(error, session.identity.tenantId)),
                ),
              ),
            }).pipe(
              Effect.map(
                ({ activeModules: modules, tenants }): HomePageModel =>
                  tenants.state === 'stale'
                    ? anonymousModel
                    : {
                        activeModules: modules,
                        identity: session.identity,
                        state: 'authenticated',
                        tenants,
                      },
              ),
            ),
      ),
      Effect.orElseSucceed((): HomePageModel => anonymousModel),
    ),
  );
};
