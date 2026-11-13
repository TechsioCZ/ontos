import { getDocumentCompositionRevision, pinDocumentCompositionRevision } from '@app/shared-contracts';
import { Effect, Fiber, Match, MutableRef, Option } from 'effect';

import type {
  AvailableLegalEntitiesResponse,
  AvailableTenant,
  AvailableTenantsResponse,
  CurrentSession,
  LegalEntityChoice,
  ModuleTargetSelector,
  SafeAuthenticatedIdentity,
  SafeTenantIdentity,
  ShellComposition,
  ShellDocumentContext,
  ShellDocumentTarget,
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
import { warmDocumentGatewayAssertions } from '../document-gateway-assertions.ts';
import { presentedShellNavigationItems } from '../../../shared/shell-platform-navigation.ts';
import { homeContributionCandidates, isHomeRequest, resolveHomeContribution } from './home-contribution-model.ts';
import type { HomeContribution } from './home-contribution-model.ts';
import type { AvailableTenantsClientError, ShellAuthenticationClientOptions } from '../../api/auth-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { browserBaseUrl, browserReadKey, browserStaleWhileRevalidateCache, keyPart } from '../browser-swr-cache.ts';
import { registerSessionScopedReset } from '../session-scope.ts';
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

/**
 * Server rendering only: the answers the browser's own Shell reads (composition, legal entities, tenants and the
 * people-administration hint) would get right after hydration. The document context resolved them once for this person
 * in this company, from the same handlers and checks as those endpoints; the browser keeps them in its read caches,
 * keyed by that person, tenant and company, instead of asking again. The session itself is not among them: the
 * browser reads it fresh, so a person or company that changed since the render never meets these answers. Nothing
 * else: no other person's or company's data, no token or assertion.
 */
export interface ServerBrowserReads {
  readonly canManagePeople: boolean;
  readonly composition: Extract<ShellComposition, { readonly state: 'available' }>;
  readonly legalEntities: AvailableLegalEntitiesResponse;
  readonly tenants: AvailableTenantsResponse;
}

export interface AuthenticatedHomePageModel {
  /** Server rendering only; see `ServerBrowserReads`. */
  readonly browserReads?: ServerBrowserReads;
  /** The company's own Home text (Core tenant data); read only for the Shell's welcome page. */
  readonly companyWelcome?: string;
  readonly compositionRevision?: string;
  readonly contextState: 'access_blocked' | 'authenticated' | 'selection_required' | 'tenant_authenticated';
  /** Module deployments this document may call; the browser obtains their assertions in one batch. */
  readonly gatewayAudiences?: readonly string[];
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

/** A session reused in the browser is at most this old; past it the next loader reads the session again. */
const SESSION_FRESH_MILLIS = 5000;

/**
 * TanStack runs this loader for every navigation and every link preload, so one Zákazníci visit read
 * `/auth/session` more than a dozen times. In the browser an authenticated session is reused for a few seconds and
 * concurrent loaders share one request. It is never answered stale: the session names the person, so a sign-in,
 * sign-out or switch elsewhere must show at the next navigation. Anonymous and failed reads are never kept. The
 * session scope (session-scope.ts) drops this cache at every boundary. Requests that carry a cookie header (server
 * rendering) always read fresh: one SSR process serves many users.
 */
const browserSessionCache = browserStaleWhileRevalidateCache(
  (baseUrl: string) => currentSession({ baseUrl: new URL(baseUrl) }),
  {
    capacity: 4,
    freshMillis: SESSION_FRESH_MILLIS,
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
    const requestedRevision = key.split(keyPart)[4] ?? '';
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

// A sign-in, sign-out or identity switch in this document drops every read answered for the previous person.
registerSessionScopedReset(resetBrowserSessionCache);

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
  if (cacheBaseUrl === undefined) {
    return shellComposition(requestedRevision === undefined ? {} : { compositionRevision: requestedRevision }, options);
  }
  const key = browserReadKey(cacheBaseUrl, identity, requestedRevision ?? '');
  const composition = browserCompositionCache.get(key);
  // The current-release answer is also the answer for its revision: the loaders that follow ask with the revision
  // the document pinned meanwhile, and would otherwise read the same composition again.
  return requestedRevision === undefined
    ? composition.pipe(
        Effect.tap((answer) =>
          answer.state === 'available'
            ? browserCompositionCache.alias(key, browserReadKey(cacheBaseUrl, identity, answer.compositionRevision))
            : Effect.void,
        ),
      )
    : composition;
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

/** The reads this document primed: each server-rendered model is primed once, never again after a session boundary. */
const primedReads = MutableRef.make(Option.none<ServerBrowserReads>());

/**
 * Keeps the server-rendered document's own Shell reads in the browser caches, under the keys the browser loaders ask
 * with, so the first loader after hydration (a preload, a navigation) asks the Shell nothing again. Primed once per
 * document model and never over an entry the cache already holds; a session boundary drops them like any read.
 */
export const primeBrowserReads = Effect.fn('HomePageModel.primeBrowserReads')(function* primeBrowserReadsEffect(
  identity: SafeTenantIdentity,
  reads: ServerBrowserReads,
  documentUrl: string = globalThis.location.href,
) {
  if (!('document' in globalThis) || Option.getOrUndefined(MutableRef.get(primedReads)) === reads) {
    return;
  }
  MutableRef.set(primedReads, Option.some(reads));
  // The loaders' requests carry the document's own URL, so this resolves the same cache keys they ask with.
  const options = yield* shellAuthenticationClientOptionsFromRequest(new Request(documentUrl));
  const cacheBaseUrl = browserBaseUrl(options);
  if (cacheBaseUrl === undefined) {
    return;
  }
  const key = browserReadKey(cacheBaseUrl, identity);
  yield* browserCompositionCache.prime(
    browserReadKey(cacheBaseUrl, identity, reads.composition.compositionRevision),
    reads.composition,
  );
  yield* browserPeopleCapabilityCache.prime(key, reads.canManagePeople);
  yield* browserLegalEntitiesCache.prime(key, reads.legalEntities);
  yield* browserTenantsCache.prime(key, reads.tenants);
});

/**
 * The document context's answers as the separate endpoints give them, when it answered every one of them; otherwise
 * the browser reads them itself.
 */
const serverBrowserReads = (
  context: ShellDocumentContext,
  composition: ServerBrowserReads['composition'],
): ServerBrowserReads | undefined =>
  context.legalEntities === undefined || context.tenants?.state !== 'available'
    ? undefined
    : {
        canManagePeople: context.canManagePeople ?? false,
        composition,
        legalEntities: context.legalEntities,
        tenants: { tenants: context.tenants.tenants },
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
    Effect.orElseSucceed(() => {
      // Optional welcome copy must not block the governed Home route.
    }),
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
    Effect.catchTag('DocumentCompositionRevisionError', (failure) =>
      failure.reason === 'uninitialized' || failure.reason === 'document-unavailable'
        ? Effect.succeed(request.headers.get('x-ontos-composition-revision') ?? undefined)
        : Effect.fail(failure),
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
): ComposedNavigation => ({
  deniedAppIds: composition.deniedAppIds,
  items: presentedShellNavigationItems(composition.navigation, canManagePeople),
  moduleIds: [...new Set(composition.navigation.map(({ moduleId }) => String(moduleId)))],
  state: 'available',
  unavailableDeployments: composition.unavailableDeployments,
});

const navigationModuleIds = (navigation: ComposedNavigation) =>
  new Set(navigation.items.map(({ moduleId }) => String(moduleId)));

/** Only a verified tenant session exposes the captured release; it never becomes a company or navigation grant. */
const capturedTenantRevision = (
  state: 'access_blocked' | 'selection_required' | 'tenant_authenticated',
  compositionRevision: ShellDocumentContext['compositionRevision'],
): string | undefined => (state === 'tenant_authenticated' ? compositionRevision : undefined);

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
 * answers session, legal entities, tenants, composition and the people-administration hint together. Separate reads
 * resolved that context five times, each in its own invocation on the document's isolate (stage: 4-5 s sequential,
 * then 2.6 s concurrent with ~1 s of their CPU queued on the document's thread). Home target admission shares this
 * invocation; gateway assertions, remote code and primary data load only in the browser.
 */
const readServerDocument = Effect.fn('HomePageModel.readServerDocument')(function* readServerDocumentEffect(
  request: Request,
  options: ShellAuthenticationClientOptions,
  target?: ModuleTargetSelector,
) {
  const requestedRevision = yield* requestedCompositionRevision(request);
  const compositionRequest = requestedRevision === undefined ? {} : { compositionRevision: requestedRevision };
  const pageRequest = isHomeRequest(request) ? { ...compositionRequest, home: true as const } : compositionRequest;
  return yield* documentContext(target === undefined ? pageRequest : { ...pageRequest, target }, options);
});

const serverHomePageModel = (context: ShellDocumentContext): HomePageModel => {
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
    // A verified tenant session may carry the real captured revision; it never carries company navigation,
    // assertions or a fabricated selected company. A missing revision keeps the session ineligible.
    const tenantRevision = capturedTenantRevision(session.state, context.compositionRevision);
    const base: AuthenticatedHomePageModel = {
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
    return tenantRevision === undefined ? base : { ...base, compositionRevision: tenantRevision };
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
  const browserReads = serverBrowserReads(context, composition);
  return {
    ...(browserReads === undefined ? model : { ...model, browserReads }),
    ...homeFields(Option.fromUndefinedOr(context.home)),
  };
};

/** The browser warms the document's gateway assertions (detached, deduplicated) so remotes join one batch. */
const warmAssertions = (compositionRevision: string, audiences: readonly string[]) =>
  audiences.length === 0 ? Effect.void : warmDocumentGatewayAssertions(compositionRevision, audiences);

/** Starts module admission only after the browser has authenticated a selected company and obtained a revision. */
type BrowserCompanyReady = (
  identity: SafeAuthenticatedIdentity,
  compositionRevision: string,
  options: ShellAuthenticationClientOptions,
) => Effect.Effect<void>;

/** A verified tenant session may pin the real captured release; every other read keeps no company navigation. */
const tenantRevisionFor = (
  state: 'access_blocked' | 'selection_required' | 'tenant_authenticated',
  identity: SafeTenantIdentity,
  options: ShellAuthenticationClientOptions,
  requestedRevision: string | undefined,
) =>
  state === 'tenant_authenticated'
    ? documentContext(requestedRevision === undefined ? {} : { compositionRevision: requestedRevision }, options).pipe(
        Effect.map((document) =>
          document.session.state === 'tenant_authenticated' &&
          document.session.identity.principalId === identity.principalId &&
          document.session.identity.tenantId === identity.tenantId
            ? document.compositionRevision
            : undefined,
        ),
        Effect.option,
        Effect.map(Option.getOrUndefined),
      )
    : Effect.void;

/** Browser loaders: every read is shared and kept in the browser cache, so a navigation rarely waits for any. */
const loadBrowserHomePageModel = Effect.fn('HomePageModel.loadBrowserHomePageModel')(
  function* loadBrowserHomePageModelEffect(
    request: Request,
    options: ShellAuthenticationClientOptions,
    onCompanyReady?: BrowserCompanyReady,
  ) {
    const session = yield* sessionFor(options);
    if (session.state === 'anonymous') {
      return anonymousModel;
    }
    if (session.state !== 'authenticated') {
      const requestedRevision = yield* requestedCompositionRevision(request);
      const tenantRevision = yield* tenantRevisionFor(session.state, session.identity, options, requestedRevision);
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
        Effect.map(({ legalEntities, tenants }): HomePageModel => {
          if (tenants.state === 'stale') {
            return sessionEndedModel;
          }
          const base = {
            contextState: session.state,
            identity: session.identity,
            legalEntities,
            navigation: emptyNavigation,
            state: 'authenticated' as const,
            tenants,
          };
          return tenantRevision === undefined ? base : { ...base, compositionRevision: tenantRevision };
        }),
      );
    }
    const requestedRevision = yield* requestedCompositionRevision(request);
    if (requestedRevision !== undefined && onCompanyReady !== undefined) {
      yield* onCompanyReady(session.identity, requestedRevision, options);
    }
    // Speculative only after company authentication. Join after composition to retain its failure precedence;
    // child fibers remain interruptible with the loader and never outlive an abandoned navigation.
    const people = yield* Effect.forkChild(peopleCapabilityFor(session.identity, options), { startImmediately: true });
    const choices = yield* Effect.forkChild(
      Effect.all(
        {
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
        { concurrency: 2 },
      ),
      { startImmediately: true },
    );
    const composition = yield* compositionFor(requestedRevision, session.identity, options);
    if (composition.state !== 'available') {
      return unavailableModel;
    }
    const { compositionRevision, gatewayAudiences } = composition;
    yield* warmAssertions(compositionRevision, gatewayAudiences);
    if ('document' in globalThis) {
      yield* pinDocumentCompositionRevision(compositionRevision, globalThis.document);
    }
    if (requestedRevision === undefined && onCompanyReady !== undefined) {
      yield* onCompanyReady(session.identity, compositionRevision, options);
    }
    const canManagePeople = yield* Fiber.join(people);
    const navigation = presentedNavigation(composition, canManagePeople);
    const homeCandidates = homeContributionCandidates(
      request,
      composition.homeComponents,
      navigationModuleIds(navigation),
    );
    return yield* Effect.all(
      {
        choices: Fiber.join(choices),
        homeContribution:
          homeCandidates === undefined
            ? Effect.succeedNone
            : resolveHomeContributionWithWelcome(session.identity, compositionRevision, homeCandidates, options).pipe(
                Effect.asSome,
              ),
      },
      { concurrency: 2 },
    ).pipe(
      Effect.map(({ choices: { legalEntities, tenants }, homeContribution }): HomePageModel => {
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

type HomePageModelFailure =
  | Effect.Error<ReturnType<typeof shellAuthenticationClientOptionsFromRequest>>
  | Effect.Error<ReturnType<typeof readServerDocument>>
  | Effect.Error<ReturnType<typeof loadBrowserHomePageModel>>;

const homePageModelOfFailure = (error: HomePageModelFailure): HomePageModel =>
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
  );

export const loadHomePageModel = Effect.fn('HomePageModel.loadHomePageModel')(
  function* loadHomePageModelEffect(request: Request, onCompanyReady?: BrowserCompanyReady) {
    const options = yield* shellAuthenticationClientOptionsFromRequest(request);
    if (isServerRenderWithoutSession(options)) {
      return anonymousModel;
    }
    return yield* isServerRender()
      ? readServerDocument(request, options).pipe(Effect.map(serverHomePageModel))
      : loadBrowserHomePageModel(request, options, onCompanyReady);
  },
  Effect.matchEffect({
    onFailure: (error) => Effect.succeed(homePageModelOfFailure(error)),
    onSuccess: Effect.succeed,
  }),
);

export interface ServerModuleDocument {
  readonly shell: HomePageModel;
  /** The page target the document read resolved against the document's release; absent when it read none. */
  readonly target?: ShellDocumentTarget;
}

/**
 * Server rendering of a module page: the document context resolves the page's target in the same request, with the
 * same session resolution and against the same captured release, instead of a second request beside it.
 */
export const loadServerModuleDocument = Effect.fn('HomePageModel.loadServerModuleDocument')(
  function* loadServerModuleDocumentEffect(request: Request, target: ModuleTargetSelector) {
    const options = yield* shellAuthenticationClientOptionsFromRequest(request);
    if (isServerRenderWithoutSession(options)) {
      return { shell: anonymousModel } satisfies ServerModuleDocument;
    }
    const context = yield* readServerDocument(request, { ...options, targetSource: 'server_render' }, target);
    const shell = serverHomePageModel(context);
    return (
      context.target === undefined ? { shell } : { shell, target: context.target }
    ) satisfies ServerModuleDocument;
  },
  Effect.matchEffect({
    onFailure: (error) => Effect.succeed<ServerModuleDocument>({ shell: homePageModelOfFailure(error) }),
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
    // The router must receive its redirect directly, not an Effect defect wrapping it.
    // oxlint-disable-next-line promise/prefer-await-to-then -- TanStack's Promise loader boundary requires the original thrown redirect; remove-when: native loader adapters preserve redirects without Promise callbacks.
    .then((model) => (model.state === 'anonymous' ? redirectToSignIn(request, model.reason) : model));
