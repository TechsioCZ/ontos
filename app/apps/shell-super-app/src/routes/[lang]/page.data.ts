/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- The loader composes typed Effect callbacks until the single runtime boundary. */
import {
  availableLegalEntities,
  availableTenants,
  currentSession,
  runEffectRequest,
  shellComposition,
} from '../../api/auth-client.ts';
import type {
  AvailableTenantsClientError,
  ShellCompositionClientError,
} from '../../api/auth-client.ts';
import { Effect } from 'effect';
import type {
  AvailableTenant,
  LegalEntityChoice,
  SafeTenantIdentity,
  ShellNavigationItem,
} from '../../../shared/api.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../shell-authentication-client-options.ts';

interface HomeLoaderArguments {
  readonly request: Request;
}

export interface AnonymousHomePageModel {
  readonly state: 'anonymous';
}

export interface UnavailableHomePageModel {
  readonly state: 'unavailable';
}

export interface AuthenticatedHomePageModel {
  readonly contextState: 'access_blocked' | 'authenticated' | 'selection_required';
  readonly identity: SafeTenantIdentity;
  readonly legalEntities:
    | { readonly items: readonly LegalEntityChoice[]; readonly state: 'available' }
    | { readonly items: readonly []; readonly state: 'unavailable' };
  readonly navigation:
    | { readonly items: readonly ShellNavigationItem[]; readonly state: 'available' }
    | { readonly items: readonly []; readonly state: 'unavailable' };
  readonly selectedLegalEntityId?: string;
  readonly state: 'authenticated';
  readonly tenants:
    | { readonly items: readonly AvailableTenant[]; readonly state: 'available' }
    | { readonly items: readonly [AvailableTenant]; readonly state: 'unavailable' };
}

export type HomePageModel =
  | AnonymousHomePageModel
  | AuthenticatedHomePageModel
  | UnavailableHomePageModel;

const anonymousModel: AnonymousHomePageModel = { state: 'anonymous' };
const unavailableModel: UnavailableHomePageModel = { state: 'unavailable' };

const unavailableNavigation = (_error: ShellCompositionClientError) => ({
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

export const loadHomePageModel = (request: Request): Promise<HomePageModel> =>
  runEffectRequest(
    shellAuthenticationClientOptionsFromRequest(request).pipe(
      Effect.flatMap((options) =>
        currentSession(options).pipe(
          Effect.flatMap((session) => {
            if (session.state === 'anonymous') {
              return Effect.succeed<HomePageModel>(anonymousModel);
            }
            const legalEntities =
              session.state === 'authenticated'
                ? availableLegalEntities(options).pipe(
                    Effect.map((response) => ({
                      items: response.legalEntities,
                      state: 'available' as const,
                    })),
                    Effect.orElseSucceed(() => ({
                      items: [] as const,
                      state: 'unavailable' as const,
                    })),
                  )
                : Effect.succeed({
                    items:
                      session.state === 'selection_required'
                        ? session.availableLegalEntities
                        : ([] as const),
                    state: 'available' as const,
                  });
            const navigation =
              session.state === 'authenticated'
                ? shellComposition(options).pipe(
                    Effect.map((composition) => ({
                      items:
                        composition.state === 'available' ? composition.navigation : ([] as const),
                      state: 'available' as const,
                    })),
                    Effect.catch((error) => Effect.succeed(unavailableNavigation(error))),
                  )
                : Effect.succeed({ items: [] as const, state: 'available' as const });
            return Effect.all({
              legalEntities,
              navigation,
              tenants: availableTenants(options).pipe(
                Effect.map(({ tenants }) => ({ items: tenants, state: 'available' as const })),
                Effect.catch((error) =>
                  Effect.succeed(tenantRead(error, session.identity.tenantId)),
                ),
              ),
            }).pipe(
              Effect.map(
                ({ legalEntities: choices, navigation: items, tenants }): HomePageModel => {
                  if (tenants.state === 'stale') {
                    return anonymousModel;
                  }
                  const model: AuthenticatedHomePageModel = {
                    contextState: session.state,
                    identity: session.identity,
                    legalEntities: choices,
                    navigation: items,
                    state: 'authenticated',
                    tenants,
                  };
                  return session.state === 'authenticated'
                    ? { ...model, selectedLegalEntityId: session.identity.legalEntityId }
                    : model;
                },
              ),
            );
          }),
        ),
      ),
      Effect.catch((error) =>
        Effect.succeed<HomePageModel>(
          error._tag === 'InvalidCredentialsProblem' ? anonymousModel : unavailableModel,
        ),
      ),
    ),
  );

export const loader = ({ request }: HomeLoaderArguments): Promise<HomePageModel> =>
  loadHomePageModel(request);
