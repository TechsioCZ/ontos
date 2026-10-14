import { getDocumentCompositionRevision, pinDocumentCompositionRevision } from '@app/shared-contracts';
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
import type { AvailableTenantsClientError, ShellAuthenticationClientOptions } from '../../api/auth-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { browserBaseUrl, browserReadKey, browserStaleWhileRevalidateCache, keyPart } from '../browser-swr-cache.ts';
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

export interface ReloadRequiredHomePageModel {
  readonly state: 'reload_required';
}

export interface AuthenticatedHomePageModel {
  readonly compositionRevision?: string;
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

export type HomePageModel =
  | AnonymousHomePageModel
  | AuthenticatedHomePageModel
  | ReloadRequiredHomePageModel
  | UnavailableHomePageModel;

const anonymousModel: AnonymousHomePageModel = { state: 'anonymous' };
const unavailableModel: UnavailableHomePageModel = { state: 'unavailable' };
const reloadRequiredModel: ReloadRequiredHomePageModel = { state: 'reload_required' };

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

/**
 * TanStack runs this loader for every navigation and every link preload, so one Zákazníci visit read
 * `/auth/session` more than a dozen times. In the browser an authenticated session is reused and concurrent loaders
 * share one request; a session older than a few seconds is still answered at once and re-read in the background, so a
 * navigation never waits for it. Anonymous and failed reads are never kept, so a fresh sign-in is seen at once;
 * sign-out and tenant or legal-entity switches reload the document, which drops the cache. Requests that carry a
 * cookie header (server rendering) always read fresh: one SSR process serves many users.
 */
const browserSessionCache = browserStaleWhileRevalidateCache(
  (baseUrl: string) => currentSession({ baseUrl: new URL(baseUrl) }),
  {
    capacity: 4,
    keep: (session) => session.state === 'authenticated',
  },
);

/**
 * The same loader also read the composition, tenants and legal entities on every navigation and preload, about
 * 1.6 s each under load. In the browser a successful answer is reused the same way, keyed by base URL, tenant,
 * legal entity and (for the composition) the pinned release, so a switch or a new release reads fresh. Failed and
 * non-available answers are never kept.
 */
const baseUrlOfKey = (key: string) => new URL(key.split(keyPart)[0] ?? '');
const keepSuccess = () => true;

const browserCompositionCache = browserStaleWhileRevalidateCache(
  (key: string) => {
    const requestedRevision = key.split(keyPart)[3] ?? '';
    return shellComposition(requestedRevision === '' ? {} : { compositionRevision: requestedRevision }, {
      baseUrl: baseUrlOfKey(key),
    });
  },
  { capacity: 4, keep: (composition) => composition.state === 'available' },
);
const browserLegalEntitiesCache = browserStaleWhileRevalidateCache(
  (key: string) => availableLegalEntities({ baseUrl: baseUrlOfKey(key) }),
  { capacity: 4, keep: keepSuccess },
);
const browserTenantsCache = browserStaleWhileRevalidateCache(
  (key: string) => availableTenants({ baseUrl: baseUrlOfKey(key) }),
  {
    capacity: 4,
    keep: keepSuccess,
  },
);

/** Drops every cached browser read (session, composition, tenants, legal entities). Tests call it between cases. */
export const resetBrowserSessionCache = Effect.all(
  [
    browserSessionCache.invalidateAll,
    browserCompositionCache.invalidateAll,
    browserLegalEntitiesCache.invalidateAll,
    browserTenantsCache.invalidateAll,
  ],
  { concurrency: 1, discard: true },
);

const sessionFor = (options: ShellAuthenticationClientOptions) => {
  const cacheBaseUrl = browserBaseUrl(options);
  const { baseUrl, ...rest } = options;
  if (cacheBaseUrl !== undefined) {
    return browserSessionCache.get(cacheBaseUrl);
  }
  return currentSession(baseUrl === undefined ? rest : { ...rest, baseUrl });
};

const compositionFor = (
  requestedRevision: string | undefined,
  identity: SafeTenantIdentity,
  options: ShellAuthenticationClientOptions,
) => {
  const cacheBaseUrl = browserBaseUrl(options);
  return cacheBaseUrl === undefined
    ? shellComposition(requestedRevision === undefined ? {} : { compositionRevision: requestedRevision }, options)
    : browserCompositionCache.get(browserReadKey(cacheBaseUrl, identity, requestedRevision ?? ''));
};

const legalEntitiesFor = (identity: SafeTenantIdentity, options: ShellAuthenticationClientOptions) => {
  const cacheBaseUrl = browserBaseUrl(options);
  return cacheBaseUrl === undefined
    ? availableLegalEntities(options)
    : browserLegalEntitiesCache.get(browserReadKey(cacheBaseUrl, identity));
};

const tenantsFor = (identity: SafeTenantIdentity, options: ShellAuthenticationClientOptions) => {
  const cacheBaseUrl = browserBaseUrl(options);
  return cacheBaseUrl === undefined
    ? availableTenants(options)
    : browserTenantsCache.get(browserReadKey(cacheBaseUrl, identity));
};

export const loadHomePageModel = Effect.fn('HomePageModel.loadHomePageModel')(
  function* loadHomePageModelEffect(request: Request) {
    const options = yield* shellAuthenticationClientOptionsFromRequest(request);
    const session = yield* sessionFor(options);
    if (session.state === 'anonymous') {
      return anonymousModel;
    }
    let compositionRevision: string | undefined;
    let navigation: AuthenticatedHomePageModel['navigation'] = {
      items: [],
      state: 'available',
      unavailableDeployments: [],
    };
    if (session.state === 'authenticated') {
      const requestedRevision = yield* getDocumentCompositionRevision().pipe(
        Effect.catchTag('DocumentCompositionRevisionError', (error) =>
          error.reason === 'uninitialized' || error.reason === 'document-unavailable'
            ? Effect.succeed(request.headers.get('x-ontos-composition-revision') ?? undefined)
            : Effect.fail(error),
        ),
      );
      const composition = yield* compositionFor(requestedRevision, session.identity, options);
      if (composition.state !== 'available') {
        return unavailableModel;
      }
      ({ compositionRevision } = composition);
      if ('document' in globalThis) {
        yield* pinDocumentCompositionRevision(compositionRevision, globalThis.document);
      }
      navigation = {
        items: composition.navigation,
        state: 'available',
        unavailableDeployments: composition.unavailableDeployments,
      };
    }
    const legalEntities =
      session.state === 'authenticated'
        ? legalEntitiesFor(session.identity, options).pipe(
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
    return yield* Effect.all(
      {
        legalEntities,
        navigation: Effect.succeed(navigation),
        tenants: tenantsFor(session.identity, options).pipe(
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
        const baseModel = {
          contextState: session.state,
          identity: session.identity,
          legalEntities: choices,
          navigation: items,
          state: 'authenticated' as const,
          tenants,
        };
        const model = compositionRevision === undefined ? baseModel : { ...baseModel, compositionRevision };
        return session.state === 'authenticated'
          ? {
              ...model,
              selectedLegalEntityId: session.identity.legalEntityId,
            }
          : model;
      }),
    );
  },
  Effect.matchEffect({
    onFailure: (error) =>
      Effect.succeed<HomePageModel>(
        Match.value(error).pipe(
          Match.tag('InvalidCredentialsProblem', () => anonymousModel),
          Match.tag('DocumentCompositionRevisionError', 'ShellReloadRequiredProblem', () => reloadRequiredModel),
          Match.tag(
            'AuthenticationInternalProblem',
            'AuthenticationUnavailableProblem',
            'ConfigError',
            'HttpClientError',
            'OntosIdentityForbiddenProblem',
            'SchemaError',
            'ShellAuthenticationRequiredProblem',
            'ShellCapabilityUnavailableProblem',
            'ShellInternalProblem',
            'ShellInvalidRequestProblem',
            'ShellPolicyConflictProblem',
            'ShellPolicyUnprocessableProblem',
            'ShellPreconditionRequiredProblem',
            'ShellRateLimitedProblem',
            'ShellTargetForbiddenProblem',
            'ShellTargetNotFoundProblem',
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
