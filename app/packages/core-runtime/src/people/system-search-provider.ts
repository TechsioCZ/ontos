import { Effect, Layer } from 'effect';
import type { OperationalScopeRequest } from '../operations/context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { ReadRuntime } from '../reads/runtime.ts';
import { CoreSearchQueryRuntimeLive } from '../search/persistence.ts';
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

/** Explicit system contribution. It never claims installation as a business module. */
export const corePeopleSystemSearchProvider = Object.freeze({
  descriptor: peopleSearchDescriptor,
  entrypoint: peopleSearchRead.descriptor.entrypoint,
  legalEntityScope: 'required',
  navigationPath: '/sprava/lide-a-role',
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
