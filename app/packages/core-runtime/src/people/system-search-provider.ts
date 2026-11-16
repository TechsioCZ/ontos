import { DateTime, Effect, Match, Schema } from 'effect';
import type { OperationalScope, OperationalScopeRequest } from '../operations/context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import type { BoundAccessGate } from '../operations/access-gate.ts';
import { ReadRuntime } from '../reads/runtime.ts';

import type { CoreSystemSearchPresentation } from '../search/search-contract.ts';
import { peopleSearchRead } from './people-search.ts';
import { peopleSearchDescriptor } from './people-search-contract.ts';
import { personResourceDescriptor } from '../resources/person.ts';

export { CoreSearchQueryRuntimeLive as PeopleSearchReadLive } from '../search/persistence.ts';
export {
  PeopleSearchRequestSchema,
  PeopleSearchResponseSchema,
  peopleSearchDescriptor,
} from './people-search-contract.ts';
export { personResourceDescriptor } from '../resources/person.ts';
export { personIdentity } from './person-identity.ts';
export { mayFindPeople } from './people-search.ts';

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

/** The canonical list gate already bound by the caller's runtime composition. */
export type PeopleSystemSearchAccess = Pick<BoundAccessGate, 'list'>;

/**
 * Coarse admission asks the same capability and row-scoped gate as the governed People search read.
 * This does not query the index or disclose a person. The actual read independently rechecks access,
 * current company membership and per-person disclosure before returning names.
 */
export const admitPeopleSystemSearch = Effect.fn('CoreSystemSearch.admitPeopleSystemSearch')(function* admitPeople(
  scope: OperationalScope,
  access: PeopleSystemSearchAccess,
) {
  // People search is company-scoped. A tenant-only request cannot invent a selected company.
  if (scope.legalEntityId === undefined) {
    return 'denied' as const;
  }
  const { descriptor } = peopleSearchRead;
  const listing = yield* access.list({
    carrier: { accessDeclaration: descriptor.accessDeclaration },
    legalEntityScope: descriptor.legalEntityScope,
    now: yield* DateTime.nowAsDate,
    scope,
  });
  return Match.value(listing.decision.outcome).pipe(
    // An allowed row-scoped decision without a predicate must not become an unfiltered read.
    Match.when('ALLOWED', () => (listing.predicate === undefined ? ('denied' as const) : ('allowed' as const))),
    Match.whenOr('DENIED', 'NEEDS_APPROVAL', () => 'denied' as const),
    // UNAVAILABLE and malformed adapter answers are not definite denials and cannot omit People.
    Match.orElse(() => 'unavailable' as const),
  );
});
