import { getDocumentCompositionRevision, pinDocumentCompositionRevision } from '@app/shared-contracts';
import { Effect, Fiber, Match, Option } from 'effect';

import type {
  AvailableTenant,
  LegalEntityChoice,
  SafeAuthenticatedIdentity,
  SafeTenantIdentity,
  ShellHomeComponent,
  ShellNavigationItem,
  ShellUnavailableDeployment,
} from '../../../shared/api.ts';
import {
  availableLegalEntities,
  availableTenants,
  canManageDemoAccounts,
  currentSession,
  executeLegalEntityDetail,
  shellComposition,
} from '../../api/auth-client.ts';
import {
  hasModuleAiApprovals,
  offersPeopleAdministration,
  withAgentPlatformNavigation,
  withConnectedAppsNavigation,
  withoutModuleAiApprovals,
  withPeopleAdministration,
} from '../shell-platform-navigation.ts';
import { homeContributionCandidates, resolveHomeContribution } from './home-contribution-model.ts';
import type { HomeContribution } from './home-contribution-model.ts';
import type { AvailableTenantsClientError, ShellAuthenticationClientOptions } from '../../api/auth-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { browserBaseUrl, browserReadKey, browserStaleWhileRevalidateCache, keyPart } from '../browser-swr-cache.ts';
import {
  isServerRender,
  isServerRenderWithoutSession,
  shellAuthenticationClientOptionsFromRequest,
} from '../shell-authentication-client-options.ts';
import { redirectToSignIn } from '../sign-in-return.ts';
import type { SignInReason } from '../sign-in-return.ts';

interface HomeLoaderArguments {
  readonly request: Request;
}

export interface AnonymousHomePageModel {
  /** Set when a browser that held a session lost it: the account was disabled, or the session is no longer valid. */
  readonly reason?: SignInReason;
  readonly state: 'anonymous';
}

export interface UnavailableHomePageModel {
  readonly state: 'unavailable';
}

export interface ReloadRequiredHomePageModel {
  readonly state: 'reload_required';
}

export interface AuthenticatedHomePageModel {
  /** The company's own Home text (Core tenant data); read only for the Shell's welcome page. */
  readonly companyWelcome?: string;
  readonly compositionRevision?: string;
  readonly contextState: 'access_blocked' | 'authenticated' | 'selection_required';
  /**
   * Set instead of `homeContribution` by server rendering: the Home components the browser resolves after hydration,
   * lowest order first.
   */
  readonly homeCandidates?: readonly ShellHomeComponent[];
  readonly homeContribution?: HomeContribution;
  readonly identity: SafeTenantIdentity;
  readonly legalEntities:
    | {
        readonly items: readonly LegalEntityChoice[];
        readonly state: 'available';
      }
    | { readonly items: readonly []; readonly state: 'unavailable' };
  readonly navigation:
    | {
        /** Deployments the person definitely cannot open here; pinned on the document for the browser gateway. */
        readonly deniedAppIds: readonly string[];
        readonly items: readonly ShellNavigationItem[];
        /** Module ids the composition lists for the person here; pinned on the document for remotes' optional reads. */
        readonly moduleIds: readonly string[];
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
const accountForbiddenModel: AnonymousHomePageModel = { reason: 'account_forbidden', state: 'anonymous' };
/** A session the Shell no longer accepts; page loaders also use it when their own read answers "sign in again". */
export const sessionEndedModel: AnonymousHomePageModel = { reason: 'session_ended', state: 'anonymous' };
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

/** Permission hints share concurrent preloads; actual people reads and writes always reauthorize server-side. */
const browserPeopleCapabilityCache = browserStaleWhileRevalidateCache(
  (key: string) => canManageDemoAccounts({ baseUrl: baseUrlOfKey(key) }),
  { capacity: 4, keep: keepSuccess },
);
const peopleCapabilityFor = (identity: SafeTenantIdentity, options: ShellAuthenticationClientOptions) => {
  const cacheBaseUrl = browserBaseUrl(options);
  return cacheBaseUrl === undefined
    ? canManageDemoAccounts(options)
    : browserPeopleCapabilityCache.get(browserReadKey(cacheBaseUrl, identity));
};

/** Drops every cached browser read (session, composition, tenants, legal entities). Tests call it between cases. */
export const resetBrowserSessionCache = Effect.all(
  [
    browserSessionCache.invalidateAll,
    browserCompositionCache.invalidateAll,
    browserLegalEntitiesCache.invalidateAll,
    browserTenantsCache.invalidateAll,
    browserPeopleCapabilityCache.invalidateAll,
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

/** What the selected company says about itself on Home; nothing when it provides no text or the read fails. */
interface HomeCompanyContext {
  readonly legalEntityId: SafeAuthenticatedIdentity['legalEntityId'];
  readonly tenantId: SafeTenantIdentity['tenantId'];
}

const companyWelcomeFor = (identity: HomeCompanyContext, options: ShellAuthenticationClientOptions) =>
  executeLegalEntityDetail(
    {
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: identity.legalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId: identity.tenantId,
      },
    },
    options,
  ).pipe(
    Effect.map(({ welcome }) => welcome),
    Effect.orElseSucceed(() => undefined),
  );

export interface ResolvedHomeContribution {
  readonly contribution: HomeContribution;
  /** The company's own Home text; read only when the Shell shows its welcome page. */
  readonly welcome?: string;
}

/** The first Home component the person may open, or the Shell's welcome page with the company's own text. */
export const resolveHomeContributionWithWelcome = (
  identity: HomeCompanyContext,
  compositionRevision: string,
  candidates: readonly ShellHomeComponent[],
  options: ShellAuthenticationClientOptions,
): Effect.Effect<ResolvedHomeContribution> =>
  resolveHomeContribution(candidates, compositionRevision, options).pipe(
    Effect.flatMap((contribution) =>
      contribution.state === 'forbidden'
        ? companyWelcomeFor(identity, options).pipe(
            Effect.map((welcome) => (welcome === undefined ? { contribution } : { contribution, welcome })),
          )
        : Effect.succeed({ contribution }),
    ),
  );

type HomeFields = Pick<AuthenticatedHomePageModel, 'companyWelcome' | 'homeCandidates' | 'homeContribution'>;

/** Home's part of the model: the resolved component, or the candidates the browser resolves after hydration. */
const homeFields = (
  resolved: Option.Option<ResolvedHomeContribution>,
  deferredCandidates: readonly ShellHomeComponent[] | undefined,
): HomeFields => {
  if (Option.isSome(resolved)) {
    const { contribution, welcome } = resolved.value;
    return welcome === undefined
      ? { homeContribution: contribution }
      : { companyWelcome: welcome, homeContribution: contribution };
  }
  return deferredCandidates === undefined ? {} : { homeCandidates: deferredCandidates };
};

const requestedCompositionRevision = (request: Request) =>
  getDocumentCompositionRevision().pipe(
    Effect.catchTag('DocumentCompositionRevisionError', (error) =>
      error.reason === 'uninitialized' || error.reason === 'document-unavailable'
        ? Effect.succeed(request.headers.get('x-ontos-composition-revision') ?? undefined)
        : Effect.fail(error),
    ),
  );

const startRead = <A, E>(read: Effect.Effect<A, E>) => Effect.forkChild(read, { startImmediately: true });

/**
 * Server rendering reads with the request's cookie and has no browser cache, so none of the document's reads needs the
 * session answer first: they all start beside the session read instead of one round trip after another (session,
 * then composition, then the people capability, then tenants and legal entities took 4-5 s on stage). Reads the
 * answer turns out not to need are interrupted when the loader returns. The people capability is only a navigation
 * hint; the server still authorizes the people page and every write.
 */
const startServerReads = Effect.fn('HomePageModel.startServerReads')(function* startServerReadsEffect(
  request: Request,
  options: ShellAuthenticationClientOptions,
) {
  const requestedRevision = yield* requestedCompositionRevision(request);
  return {
    composition: yield* startRead(
      shellComposition(requestedRevision === undefined ? {} : { compositionRevision: requestedRevision }, options),
    ),
    legalEntities: yield* startRead(availableLegalEntities(options)),
    peopleCapability: yield* startRead(canManageDemoAccounts(options)),
    tenants: yield* startRead(availableTenants(options)),
  };
});

export const loadHomePageModel = Effect.fn('HomePageModel.loadHomePageModel')(
  function* loadHomePageModelEffect(request: Request) {
    const options = yield* shellAuthenticationClientOptionsFromRequest(request);
    if (isServerRenderWithoutSession(options)) {
      return anonymousModel;
    }
    const serverReads = isServerRender() ? yield* startServerReads(request, options) : undefined;
    const session = yield* sessionFor(options);
    if (session.state === 'anonymous') {
      return anonymousModel;
    }
    let compositionRevision: string | undefined;
    let homeCandidates: readonly ShellHomeComponent[] | undefined;
    let navigation: AuthenticatedHomePageModel['navigation'] = {
      deniedAppIds: [],
      items: [],
      moduleIds: [],
      state: 'available',
      unavailableDeployments: [],
    };
    if (session.state === 'authenticated') {
      const composition = yield* serverReads === undefined
        ? requestedCompositionRevision(request).pipe(
            Effect.flatMap((requestedRevision) => compositionFor(requestedRevision, session.identity, options)),
          )
        : Fiber.join(serverReads.composition);
      if (composition.state !== 'available') {
        return unavailableModel;
      }
      ({ compositionRevision } = composition);
      if ('document' in globalThis) {
        yield* pinDocumentCompositionRevision(compositionRevision, globalThis.document);
      }
      const canManagePeople = offersPeopleAdministration(composition.navigation)
        ? yield* serverReads === undefined
            ? peopleCapabilityFor(session.identity, options)
            : Fiber.join(serverReads.peopleCapability)
        : false;
      const presentable = withPeopleAdministration(composition.navigation, canManagePeople);
      navigation = {
        deniedAppIds: composition.deniedAppIds,
        items: withConnectedAppsNavigation(
          withAgentPlatformNavigation(
            withoutModuleAiApprovals(presentable),
            canManagePeople || hasModuleAiApprovals(presentable),
          ),
          canManagePeople,
        ),
        moduleIds: [...new Set(composition.navigation.map(({ moduleId }) => String(moduleId)))],
        state: 'available',
        unavailableDeployments: composition.unavailableDeployments,
      };
      homeCandidates = homeContributionCandidates(
        request,
        composition.homeComponents,
        new Set(navigation.items.map(({ moduleId }) => String(moduleId))),
      );
    }
    const legalEntities =
      session.state === 'authenticated'
        ? (serverReads === undefined
            ? legalEntitiesFor(session.identity, options)
            : Fiber.join(serverReads.legalEntities)
          ).pipe(
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
    // The Home component is a browser-loaded remote, so the server never waits for it: the document streams the
    // Shell frame and the browser resolves the candidates after hydration. Browser navigations resolve it here.
    const deferHomeContribution = serverReads !== undefined && homeCandidates !== undefined;
    return yield* Effect.all(
      {
        homeContribution:
          session.state === 'authenticated' &&
          compositionRevision !== undefined &&
          homeCandidates !== undefined &&
          !deferHomeContribution
            ? resolveHomeContributionWithWelcome(session.identity, compositionRevision, homeCandidates, options).pipe(
                Effect.asSome,
              )
            : Effect.succeedNone,
        legalEntities,
        navigation: Effect.succeed(navigation),
        tenants: (serverReads === undefined
          ? tenantsFor(session.identity, options)
          : Fiber.join(serverReads.tenants)
        ).pipe(
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
      Effect.map(({ homeContribution, legalEntities: choices, navigation: items, tenants }): HomePageModel => {
        if (tenants.state === 'stale') {
          return sessionEndedModel;
        }
        const baseModel = {
          contextState: session.state,
          identity: session.identity,
          legalEntities: choices,
          navigation: items,
          state: 'authenticated' as const,
          tenants,
        };
        const withContribution = {
          ...baseModel,
          ...homeFields(homeContribution, deferHomeContribution ? homeCandidates : undefined),
        };
        const model =
          compositionRevision === undefined ? withContribution : { ...withContribution, compositionRevision };
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
          // A disabled account keeps its browser cookie, but the session read answers 403: that is "not signed in
          // (account without access)", not an outage. A session the Shell no longer accepts is "not signed in" too.
          Match.tag('OntosIdentityForbiddenProblem', () => accountForbiddenModel),
          Match.tag('ShellAuthenticationRequiredProblem', () => sessionEndedModel),
          Match.tag('DocumentCompositionRevisionError', 'ShellReloadRequiredProblem', () => reloadRequiredModel),
          Match.tag(
            'AuthenticationInternalProblem',
            'AuthenticationUnavailableProblem',
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
            () => unavailableModel,
          ),
          Match.exhaustive,
        ),
      ),
    onSuccess: Effect.succeed,
  }),
);

export const loader = ({ request }: HomeLoaderArguments): Promise<HomePageModel> =>
  browserRuntime
    .runPromise(loadHomePageModel(request), {
      signal: request.signal,
    })
    // Without a live session the dashboard has nothing to show: go to sign-in (with the reason when it died).
    .then((model) => (model.state === 'anonymous' ? redirectToSignIn(request, model.reason) : model));
