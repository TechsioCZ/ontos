import { Effect, Match } from 'effect';

import type {
  AvailableTenant,
  LegalEntityChoice,
  SafeAuthenticatedIdentity,
  SafeTenantIdentity,
  ShellNavigationItem,
  ShellUnavailableDeployment,
} from '../../../shared/api.ts';
import { availableLegalEntities, availableTenants, currentSession, shellComposition } from '../../api/auth-client.ts';
import type { AvailableTenantsClientError, ShellCompositionClientError } from '../../api/auth-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
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
    | {
        readonly items: readonly LegalEntityChoice[];
        readonly state: 'available';
      }
    | { readonly items: readonly []; readonly state: 'unavailable' };
  readonly navigation:
    | {
        readonly items: readonly ShellNavigationItem[];
        readonly state: 'available';
        readonly unavailableDeployments: readonly ShellUnavailableDeployment[];
      }
    | {
        readonly items: readonly [];
        readonly state: 'unavailable';
        readonly unavailableDeployments: readonly [];
      };
  readonly selectedLegalEntityId?: SafeAuthenticatedIdentity['legalEntityId'];
  readonly state: 'authenticated';
  readonly tenants:
    | {
        readonly items: readonly AvailableTenant[];
        readonly state: 'available';
      }
    | {
        readonly items: readonly [AvailableTenant];
        readonly state: 'unavailable';
      };
}

export type HomePageModel = AnonymousHomePageModel | AuthenticatedHomePageModel | UnavailableHomePageModel;

const anonymousModel: AnonymousHomePageModel = { state: 'anonymous' };
const unavailableModel: UnavailableHomePageModel = { state: 'unavailable' };

const unavailableNavigation = (_error: ShellCompositionClientError) => ({
  items: [] as const,
  state: 'unavailable' as const,
  unavailableDeployments: [] as const,
});

const unavailableTenants = (tenantId: SafeTenantIdentity['tenantId']) => ({
  items: [{ name: tenantId, tenantId }] as const,
  state: 'unavailable' as const,
});

const tenantRead = (error: AvailableTenantsClientError, tenantId: SafeTenantIdentity['tenantId']) =>
  Match.value(error).pipe(
    Match.tag('TenantAuthenticationRequiredProblem', () => ({
      state: 'stale' as const,
    })),
    Match.tag('HttpClientError', 'SchemaError', 'TenantCapabilityUnavailableProblem', 'TenantInternalProblem', () =>
      unavailableTenants(tenantId),
    ),
    Match.exhaustive,
  );

export const loadHomePageModel = (request: Request) =>
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
                  items: session.state === 'selection_required' ? session.availableLegalEntities : ([] as const),
                  state: 'available' as const,
                });
          const navigation =
            session.state === 'authenticated'
              ? shellComposition(options).pipe(
                  Effect.map((composition) => ({
                    items: composition.state === 'available' ? composition.navigation : ([] as const),
                    state: 'available' as const,
                    unavailableDeployments:
                      composition.state === 'available' ? composition.unavailableDeployments : ([] as const),
                  })),
                  Effect.matchEffect({
                    onFailure: (error) => Effect.succeed(unavailableNavigation(error)),
                    onSuccess: Effect.succeed,
                  }),
                )
              : Effect.succeed({
                  items: [] as const,
                  state: 'available' as const,
                  unavailableDeployments: [] as const,
                });
          return Effect.all(
            {
              legalEntities,
              navigation,
              tenants: availableTenants(options).pipe(
                Effect.map(({ tenants }) => ({
                  items: tenants,
                  state: 'available' as const,
                })),
                Effect.matchEffect({
                  onFailure: (error) => Effect.succeed(tenantRead(error, session.identity.tenantId)),
                  onSuccess: Effect.succeed,
                }),
              ),
            },
            { concurrency: 3 },
          ).pipe(
            Effect.map(({ legalEntities: choices, navigation: items, tenants }): HomePageModel => {
              if (tenants.state === 'stale') {
                return anonymousModel;
              }
              const model = {
                contextState: session.state,
                identity: session.identity,
                legalEntities: choices,
                navigation: items,
                state: 'authenticated' as const,
                tenants,
              };
              return session.state === 'authenticated'
                ? {
                    ...model,
                    selectedLegalEntityId: session.identity.legalEntityId,
                  }
                : model;
            }),
          );
        }),
      ),
    ),
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.succeed<HomePageModel>(
          Match.value(error).pipe(
            Match.tag('InvalidCredentialsProblem', () => anonymousModel),
            Match.tag(
              'AuthenticationInternalProblem',
              'AuthenticationUnavailableProblem',
              'ConfigError',
              'HttpClientError',
              'OntosIdentityForbiddenProblem',
              'SchemaError',
              () => unavailableModel,
            ),
            Match.exhaustive,
          ),
        ),
      onSuccess: Effect.succeed,
    }),
  );

export const loader = ({ request }: HomeLoaderArguments): Promise<HomePageModel> =>
  browserRuntime.runPromise(loadHomePageModel(request), {
    signal: request.signal,
  });
