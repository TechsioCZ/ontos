import { Effect, Layer, Predicate, Schema } from 'effect';
import type { OperationalScope, OperationalScopeRequest } from '../operations/context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import type { ContextAccessService } from '../permissions/context-access.ts';
import { getReadPermissionTargetResolver } from '../reads/definition.ts';
import type { AtomicResolvedReadPermissionTarget } from '../reads/definition.ts';
import { ReadRuntime } from '../reads/runtime.ts';
import { CoreSearchQueryRuntimeLive } from '../search/persistence.ts';
import type { CoreSystemSearchPresentation } from '../search/search-contract.ts';
import { PeopleSearchVisibilityLive } from './people-search-visibility.ts';
import { peopleSearchRead } from './people-search.ts';
import { peopleSearchDescriptor } from './people-search-contract.ts';
import { personResourceDescriptor } from '../resources/person.ts';

export {
  PeopleSearchRequestSchema,
  PeopleSearchResponseSchema,
  peopleSearchDescriptor,
} from './people-search-contract.ts';
export { personResourceDescriptor } from '../resources/person.ts';
export { personIdentity } from './person-identity.ts';

const corePeopleNavigationPath = '/sprava/lide-a-role' as const;

/**
 * Bounded system-only presentation data for the explicit Core people provider. It is outside the
 * installed business catalog and never invents a business page key. This module may depend on the
 * browser-safe leaf; the leaf must never import this backend module.
 */
export const corePeopleSystemSearchPresentation = Object.freeze({
  entrypointKey: peopleSearchRead.descriptor.entrypoint.entrypointKey,
  family: {
    icon: 'icon-[mdi--account-group-outline]',
    key: 'people',
    label: { cs: 'Lidé', en: 'People' },
    order: 10,
  },
  group: {
    icon: 'icon-[mdi--account-outline]',
    key: 'person',
    label: { cs: 'Lidé', en: 'People' },
    order: 10,
  },
  idEncoding: 'native',
  idFormat: 'opaque',
  kind: 'system',
  navigationPath: corePeopleNavigationPath,
  ownerModuleId: peopleSearchDescriptor.owningModuleId,
  queryParameterName: 'person',
  resourceType: personResourceDescriptor.key,
  schemaVersion: '1',
  scope: 'company',
  searchKey: peopleSearchDescriptor.key,
} as const satisfies CoreSystemSearchPresentation);

/** Explicit system contribution. It never claims installation as a business module. */
export const corePeopleSystemSearchProvider = Object.freeze({
  descriptor: peopleSearchDescriptor,
  entrypoint: peopleSearchRead.descriptor.entrypoint,
  legalEntityScope: 'required',
  navigationPath: corePeopleNavigationPath,
  presentation: corePeopleSystemSearchPresentation,
  resource: personResourceDescriptor,
} as const);
export const PeopleSearchReadLive = Layer.mergeAll(PeopleSearchVisibilityLive, CoreSearchQueryRuntimeLive);
export const runPeopleSearch = Effect.fn('CoreSystemSearch.runPeopleSearch')(function* runPeopleSearch(input: {
  readonly input: { readonly query: string };
  readonly principal: TrustedPrincipalContext;
  readonly transport: OperationalScopeRequest;
}) {
  const runtime = yield* ReadRuntime;
  return yield* runtime.runRead({ ...input, registration: peopleSearchRead }).pipe(
    // An absent people capability omits this provider; uncertainty is not a definite denial.
    Effect.catchTags({
      OperationContextDenied: () => Effect.succeed([]),
      ReadPermissionDenied: () => Effect.succeed([]),
    }),
  );
});

export type { PeopleSearchRequest, PeopleSearchResponse, PeopleSearchResult } from './people-search-contract.ts';

export type PeopleSearchRequirements = Effect.Services<ReturnType<typeof runPeopleSearch>>;

/** One coarse principal admission decision for the Core people system search, without running its data provider. */
export const PeopleSystemSearchAdmissionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
export type PeopleSystemSearchAdmission = typeof PeopleSystemSearchAdmissionSchema.Type;

/** The exact `ContextAccess` capabilities the admission check needs; the caller supplies them, never the environment. */
export type PeopleSystemSearchAccess = Pick<ContextAccessService, 'legalEntities' | 'modules' | 'tenants'>;

/**
 * The declared Core people read evaluates a static, input-independent directory alternative; this probe only fills the
 * resolver signature and never selects a policy branch.
 */
const peopleAdmissionProbe = { query: 'admission' } as const;

/**
 * One exact decision from a `ContextAccess` adapter. The input is deliberately a plain string shape: the service
 * interface types the literal, but an adapter is a runtime seam, so a value outside the closed vocabulary must fail
 * closed as `unavailable` rather than be trusted.
 */
export const peopleAdmissionDecisionOf = (
  decisions: readonly { readonly decision: string; readonly key: string }[],
  expectedKey: string,
): PeopleSystemSearchAdmission => {
  const [decision, ...unexpected] = decisions;
  if (unexpected.length !== 0 || decision?.key !== expectedKey) {
    return 'unavailable';
  }
  return Schema.is(PeopleSystemSearchAdmissionSchema)(decision.decision) ? decision.decision : 'unavailable';
};

/**
 * Coarse admission of the Core people system search for one verified scope, without running the data provider.
 *
 * It checks exactly the requirements the read itself declares: the system entrypoint's `module.access` context
 * permission and the directory alternative `any_of(tenant.read_people, legal_entity.read_people)`. Both gates are
 * independent and must be allowed; the directory alternative is satisfied when any one of its targets is allowed. A
 * definite denial of either gate denies; any indeterminate or malformed decision fails closed as `unavailable`.
 * Per-record filtering and the data read stay with `runPeopleSearch`.
 */
export const admitPeopleSystemSearch = Effect.fn('CoreSystemSearch.admitPeopleSystemSearch')(function* admitPeople(
  scope: OperationalScope,
  access: PeopleSystemSearchAccess,
) {
  const resolver = getReadPermissionTargetResolver(peopleSearchRead);
  if (!Predicate.isFunction(resolver)) {
    return 'unavailable' as const;
  }
  const declared = resolver(peopleAdmissionProbe, scope);
  const targets: readonly AtomicResolvedReadPermissionTarget[] =
    declared.kind === 'any_of' ? [...declared.targets] : [declared];
  const { entrypoint } = peopleSearchRead.descriptor;
  let moduleDecision: PeopleSystemSearchAdmission = 'unavailable';
  if (
    entrypoint.authorization.kind === 'context_permission' &&
    entrypoint.authorization.permission === 'module.access' &&
    scope.legalEntityId !== undefined
  ) {
    moduleDecision = peopleAdmissionDecisionOf(
      yield* access.modules({
        legalEntityId: scope.legalEntityId,
        moduleIds: [entrypoint.moduleKey],
        principalId: scope.principalId,
        tenantId: scope.tenantId,
      }),
      entrypoint.moduleKey,
    );
  }
  const directoryDecisions = yield* Effect.forEach(
    targets,
    (candidate): Effect.Effect<PeopleSystemSearchAdmission> => {
      if (candidate.kind === 'tenant') {
        return access
          .tenants({ permission: candidate.permission, principalId: scope.principalId, tenantIds: [scope.tenantId] })
          .pipe(Effect.map((decisions) => peopleAdmissionDecisionOf(decisions, scope.tenantId)));
      }
      if (candidate.kind === 'legal_entity') {
        const legalEntityId = candidate.legalEntityId ?? scope.legalEntityId ?? '';
        const request = {
          legalEntityIds: [legalEntityId],
          principalId: scope.principalId,
          tenantId: scope.tenantId,
        };
        return (
          candidate.permission === undefined
            ? access.legalEntities(request)
            : access.legalEntities({ ...request, permission: candidate.permission })
        ).pipe(Effect.map((decisions) => peopleAdmissionDecisionOf(decisions, legalEntityId)));
      }
      // The declared directory alternative is tenant/legal-entity only; any other branch fails closed.
      return Effect.succeed('unavailable' as const);
    },
    { concurrency: 4 },
  );
  // The directory alternative is `any_of`: one allowed target admits it, and only all-denied targets deny it. The
  // entrypoint `module.access` is then an independent required gate, so a denial there still wins.
  const directory = new Set(directoryDecisions);
  let directoryDecision: PeopleSystemSearchAdmission = 'denied';
  if (directory.has('allowed')) {
    directoryDecision = 'allowed';
  } else if (directory.has('unavailable')) {
    directoryDecision = 'unavailable';
  }
  const decisions = new Set<PeopleSystemSearchAdmission>([moduleDecision, directoryDecision]);
  if (decisions.has('denied')) {
    return 'denied' as const;
  }
  return decisions.has('unavailable') ? ('unavailable' as const) : ('allowed' as const);
});
