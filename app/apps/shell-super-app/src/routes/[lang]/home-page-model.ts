import { getDocumentCompositionRevision, pinDocumentCompositionRevision } from '@app/shared-contracts';
import { Effect, Match, Option } from 'effect';

import type {
  AvailableTenant,
  CurrentSession,
  LegalEntityChoice,
  SafeAuthenticatedIdentity,
  SafeTenantIdentity,
  ShellComposition,
  ShellHomeComponent,
  ShellNavigationItem,
  ShellUnavailableDeployment,
} from '../../../shared/api.ts';
import {
  availableLegalEntities,
  availableTenants,
  canManageDemoAccounts,
  currentSession,
  documentContext,
  executeLegalEntityDetail,
  shellComposition,
} from '../../api/auth-client.ts';
import type { DocumentGatewayAssertion } from '../../../shared/document-gateway-api.ts';
import { warmDocumentGatewayAssertions } from '../document-gateway-assertions.ts';
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
import { modulePageProps, prepareModulePage } from '../remote-page-loader.ts';
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
  readonly contextState: 'access_blocked' | 'authenticated' | 'selection_required' | 'tenant_authenticated';
  /**
   * Server rendering only, when the batch answered in time: the document's gateway assertions, one per module audience,
   * so the browser's first module reads need no assertion round trip. Kept in memory (document-gateway-assertions.ts).
   */
  readonly gatewayAssertions?: readonly DocumentGatewayAssertion[];
  /** Module deployments this document may call; the browser obtains their assertions in one batch. */
  readonly gatewayAudiences?: readonly string[];
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
        readonly tenantContextAvailable?: boolean;
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

type HomeFields = Pick<AuthenticatedHomePageModel, 'companyWelcome' | 'homeContribution'>;

/** Home's part of a browser loader's model: the resolved component and, on the welcome page, the company's text. */
const homeFields = (resolved: Option.Option<ResolvedHomeContribution>): HomeFields =>
  Option.match(resolved, {
    onNone: () => ({}),
    onSome: ({ contribution, welcome }) =>
      welcome === undefined
        ? { homeContribution: contribution }
        : { companyWelcome: welcome, homeContribution: contribution },
  });

const requestedCompositionRevision = (request: Request) =>
  getDocumentCompositionRevision().pipe(
    Effect.catchTag('DocumentCompositionRevisionError', (error) =>
      error.reason === 'uninitialized' || error.reason === 'document-unavailable'
        ? Effect.succeed(request.headers.get('x-ontos-composition-revision') ?? undefined)
        : Effect.fail(error),
    ),
  );

type ComposedNavigation = Extract<AuthenticatedHomePageModel['navigation'], { readonly state: 'available' }>;

const emptyNavigation: ComposedNavigation = {
  deniedAppIds: [],
  items: [],
  moduleIds: [],
  state: 'available',
  unavailableDeployments: [],
};

/** The person's sidebar: the composed destinations plus the Shell's own platform pages they may open. */
const presentedNavigation = (
  composition: Extract<ShellComposition, { readonly state: 'available' }>,
  canManagePeople: boolean,
): ComposedNavigation => {
  const presentable = withPeopleAdministration(composition.navigation, canManagePeople);
  return {
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
};

const navigationModuleIds = (navigation: ComposedNavigation) =>
  new Set(navigation.items.map(({ moduleId }) => String(moduleId)));

const legalEntitiesWithoutSelection = (session: Exclude<CurrentSession, { readonly state: 'anonymous' }>) => ({
  items:
    session.state === 'selection_required' || session.state === 'tenant_authenticated'
      ? session.availableLegalEntities
      : ([] as const),
  state: 'available' as const,
});

const unavailableLegalEntities = { items: [] as const, state: 'unavailable' as const };

/**
 * Server rendering reads the whole document context in ONE request: the BFF resolves the session's context once and
 * answers session, legal entities, tenants, composition, the people-administration hint and the gateway assertions of
 * the composition's audiences together. Separate reads resolved that context five times, each in its own invocation
 * on the document's isolate (stage: 4-5 s sequential, then 2.6 s concurrent with ~1 s of their CPU queued on the
 * document's thread), and a separate assertion batch waited for the composition before resolving the session again.
 * The Home component is a browser-loaded remote, so the server never resolves it: the model carries its candidates
 * and the browser resolves them after hydration.
 */
const loadServerHomePageModel = Effect.fn('HomePageModel.loadServerHomePageModel')(
  function* loadServerHomePageModelEffect(request: Request, options: ShellAuthenticationClientOptions) {
    const requestedRevision = yield* requestedCompositionRevision(request);
    const context = yield* documentContext(
      requestedRevision === undefined ? {} : { compositionRevision: requestedRevision },
      options,
    );
    const { session } = context;
    if (session.state === 'anonymous') {
      return anonymousModel;
    }
    const tenants =
      context.tenants?.state === 'available'
        ? { items: context.tenants.tenants, state: 'available' as const }
        : unavailableTenants(session.identity.tenantId);
    if (session.state !== 'authenticated') {
      if (context.tenants?.state === 'authentication_required') {
        return sessionEndedModel;
      }
      const model: AuthenticatedHomePageModel = {
        contextState: session.state,
        identity: session.identity,
        legalEntities:
          context.legalEntities === undefined
            ? legalEntitiesWithoutSelection(session)
            : {
                items: context.legalEntities.legalEntities,
                state: 'available',
                tenantContextAvailable: context.legalEntities.tenantContextAvailable,
              },
        navigation: emptyNavigation,
        state: 'authenticated',
        tenants,
      };
      return model;
    }
    const composition = context.composition ?? { state: 'unavailable' as const };
    if (composition.state === 'reload_required') {
      return reloadRequiredModel;
    }
    if (composition.state !== 'available') {
      return unavailableModel;
    }
    if (context.tenants?.state === 'authentication_required') {
      return sessionEndedModel;
    }
    const navigation = presentedNavigation(composition, context.canManagePeople ?? false);
    const homeCandidates = homeContributionCandidates(
      request,
      composition.homeComponents,
      navigationModuleIds(navigation),
    );
    const model: AuthenticatedHomePageModel = {
      compositionRevision: composition.compositionRevision,
      contextState: session.state,
      gatewayAudiences: composition.gatewayAudiences,
      identity: session.identity,
      legalEntities:
        context.legalEntities === undefined
          ? unavailableLegalEntities
          : {
              items: context.legalEntities.legalEntities,
              state: 'available',
              tenantContextAvailable: context.legalEntities.tenantContextAvailable,
            },
      navigation,
      selectedLegalEntityId: session.identity.legalEntityId,
      state: 'authenticated',
      tenants,
    };
    const withAssertions =
      context.gatewayAssertions === undefined ? model : { ...model, gatewayAssertions: context.gatewayAssertions };
    return homeCandidates === undefined ? withAssertions : { ...withAssertions, homeCandidates };
  },
);

/** The browser warms the document's gateway assertions (detached, deduplicated) so remotes join one batch. */
const warmAssertions = (compositionRevision: string, audiences: readonly string[]) =>
  audiences.length === 0 ? Effect.void : warmDocumentGatewayAssertions(compositionRevision, audiences);

/** Browser loaders: every read is shared and kept in the browser cache, so a navigation rarely waits for any. */
const loadBrowserHomePageModel = Effect.fn('HomePageModel.loadBrowserHomePageModel')(
  function* loadBrowserHomePageModelEffect(request: Request, options: ShellAuthenticationClientOptions) {
    const session = yield* sessionFor(options);
    if (session.state === 'anonymous') {
      return anonymousModel;
    }
    if (session.state !== 'authenticated') {
      return yield* Effect.all(
        {
          legalEntities: legalEntitiesFor(session.identity, options).pipe(
            Effect.map((response) => ({
              items: response.legalEntities,
              state: 'available' as const,
              tenantContextAvailable: response.tenantContextAvailable,
            })),
            Effect.orElseSucceed(() => legalEntitiesWithoutSelection(session)),
          ),
          tenants: tenantsFor(session.identity, options).pipe(
            Effect.map(({ tenants }) => ({ items: tenants, state: 'available' as const })),
            Effect.matchEffect({
              onFailure: (error) => Effect.succeed(tenantRead(error, session.identity.tenantId)),
              onSuccess: Effect.succeed,
            }),
          ),
        },
        { concurrency: 2 },
      ).pipe(
        Effect.map(({ legalEntities, tenants }): HomePageModel =>
          tenants.state === 'stale'
            ? sessionEndedModel
            : {
                contextState: session.state,
                identity: session.identity,
                legalEntities,
                navigation: emptyNavigation,
                state: 'authenticated',
                tenants,
              },
        ),
      );
    }
    const requestedRevision = yield* requestedCompositionRevision(request);
    const composition = yield* compositionFor(requestedRevision, session.identity, options);
    if (composition.state !== 'available') {
      return unavailableModel;
    }
    const { compositionRevision, gatewayAudiences } = composition;
    yield* warmAssertions(compositionRevision, gatewayAudiences);
    if ('document' in globalThis) {
      yield* pinDocumentCompositionRevision(compositionRevision, globalThis.document);
    }
    const canManagePeople = offersPeopleAdministration(composition.navigation)
      ? yield* peopleCapabilityFor(session.identity, options)
      : false;
    const navigation = presentedNavigation(composition, canManagePeople);
    const homeCandidates = homeContributionCandidates(
      request,
      composition.homeComponents,
      navigationModuleIds(navigation),
    );
    return yield* Effect.all(
      {
        homeContribution:
          homeCandidates === undefined
            ? Effect.succeedNone
            : resolveHomeContributionWithWelcome(session.identity, compositionRevision, homeCandidates, options).pipe(
                Effect.asSome,
              ),
        legalEntities: legalEntitiesFor(session.identity, options).pipe(
          Effect.map((response) => ({
            items: response.legalEntities,
            state: 'available' as const,
            tenantContextAvailable: response.tenantContextAvailable,
          })),
          Effect.orElseSucceed(() => unavailableLegalEntities),
        ),
        tenants: tenantsFor(session.identity, options).pipe(
          Effect.map(({ tenants }) => ({ items: tenants, state: 'available' as const })),
          Effect.matchEffect({
            onFailure: (error) => Effect.succeed(tenantRead(error, session.identity.tenantId)),
            onSuccess: Effect.succeed,
          }),
        ),
      },
      { concurrency: 3 },
    ).pipe(
      Effect.map(({ homeContribution, legalEntities, tenants }): HomePageModel => {
        if (tenants.state === 'stale') {
          return sessionEndedModel;
        }
        return {
          compositionRevision,
          contextState: session.state,
          gatewayAudiences,
          identity: session.identity,
          legalEntities,
          navigation,
          selectedLegalEntityId: session.identity.legalEntityId,
          state: 'authenticated',
          tenants,
          ...homeFields(homeContribution),
        };
      }),
    );
  },
);

export const loadHomePageModel = Effect.fn('HomePageModel.loadHomePageModel')(
  function* loadHomePageModelEffect(request: Request) {
    const options = yield* shellAuthenticationClientOptionsFromRequest(request);
    if (isServerRenderWithoutSession(options)) {
      return anonymousModel;
    }
    return yield* isServerRender()
      ? loadServerHomePageModel(request, options)
      : loadBrowserHomePageModel(request, options);
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

/** Home waits for its module component's code and primary data like any page, so it reveals real content. */
const HOME_PREPARE_BUDGET = '2500 millis';

const prepareHomeContribution = (model: HomePageModel, request: Request) =>
  model.state === 'authenticated' && model.homeContribution?.state === 'ready'
    ? prepareModulePage(
        model.homeContribution.target,
        modulePageProps(model, {}, ''),
        new URL(request.url).pathname,
        HOME_PREPARE_BUDGET,
      ).pipe(Effect.asVoid)
    : Effect.void;

export const loader = ({ request }: HomeLoaderArguments): Promise<HomePageModel> =>
  browserRuntime
    .runPromise(loadHomePageModel(request).pipe(Effect.tap((model) => prepareHomeContribution(model, request))), {
      signal: request.signal,
    })
    // Without a live session the dashboard has nothing to show: go to sign-in (with the reason when it died).
    .then((model) => (model.state === 'anonymous' ? redirectToSignIn(request, model.reason) : model));
