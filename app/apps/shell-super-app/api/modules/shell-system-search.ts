import {
  runPeopleSearch,
  PeopleSearchResponseSchema,
  personIdentity,
  corePeopleSystemSearchProvider,
} from '@app/core-runtime/people/search';
import type { PeopleSearchResponse, PeopleSearchRequirements } from '@app/core-runtime/people/search';
import { Context, Effect, Layer, Option, Result, Schema } from 'effect';
import { ShellSearchResponseSchema } from '../../shared/browser-api.ts';
import type { ShellSearchPresentationInventory, ShellSearchResponse } from '../../shared/browser-api.ts';
import { withShellSearchRequestBudget } from './shell-governed-search.ts';
import { ShellProviderUnavailableError, sortShellSearchResults } from './shell-resources.ts';
import type { ShellResourceContext } from './shell-resources.ts';
import { observeShellSearchProvider } from './shell-search-diagnostics.ts';

const unavailable = (cause?: unknown) => new ShellProviderUnavailableError(cause === undefined ? {} : { cause });
/**
 * Core remains outside the installed business-module catalog. This branch admits one exact system contract:
 * only rows of the selected company's own people projection. Who may see a person at all is decided by the
 * owner read itself (`core.identity.people-directory.list`, the People list's capability).
 */
export const authorizePeopleSearchResults: (
  scope: ShellResourceContext,
  values: PeopleSearchResponse,
) => Effect.Effect<ShellSearchResponse['results'], ShellProviderUnavailableError> = Effect.fn(
  'ShellSystemSearch.authorizePeopleResults',
)(function* authorize(scope: ShellResourceContext, values: PeopleSearchResponse) {
  const decoded = yield* Schema.decodeEffect(PeopleSearchResponseSchema, {
    onExcessProperty: 'error',
  })(values).pipe(Effect.mapError(unavailable));
  if (scope.legalEntityId === undefined) {
    return [];
  }
  const scoped = decoded.filter(({ ref, selectedLegalEntityId }) => {
    const person = personIdentity(ref.resourceId);
    return (
      ref.tenantId === scope.tenantId &&
      selectedLegalEntityId === scope.legalEntityId &&
      ref.moduleId === corePeopleSystemSearchProvider.descriptor.owningModuleId &&
      ref.resourceType === corePeopleSystemSearchProvider.resource.key &&
      Option.isSome(person) &&
      person.value.legalEntityId === scope.legalEntityId
    );
  });
  const results = scoped.map((row) => ({ ...row, kind: 'resource' as const }));
  const response = yield* Schema.decodeEffect(ShellSearchResponseSchema)({ partial: false, results }).pipe(
    Effect.mapError(unavailable),
  );
  return response.results;
});

export class ShellSystemSearch extends Context.Service<
  ShellSystemSearch,
  {
    readonly search: (
      scope: ShellResourceContext,
      query: string,
    ) => Effect.Effect<ShellSearchResponse, ShellProviderUnavailableError>;
  }
>()('@app/shell-super-app/api/modules/shell-system-search/ShellSystemSearch') {}

/** The application root supplies one existing ReadRuntime/persistence graph, captured once, not per search. */
export const ShellPeopleSystemSearchLive: Layer.Layer<ShellSystemSearch, never, PeopleSearchRequirements> =
  Layer.effect(
    ShellSystemSearch,
    Effect.gen(function* live() {
      const environment = yield* Effect.context<Effect.Services<ReturnType<typeof runPeopleSearch>>>();
      return {
        search: Effect.fn('ShellSystemSearch.people')(
          function* search(scope: ShellResourceContext, query: string) {
            if (scope.legalEntityId === undefined || query.trim().length === 0) {
              return { partial: false, results: [] };
            }
            const operation = runPeopleSearch({
              input: { query },
              principal: scope,
              transport: { correlationId: scope.correlationId },
            }).pipe(
              Effect.mapError(unavailable),
              Effect.flatMap((values) => authorizePeopleSearchResults(scope, values)),
              Effect.map((results) => ({ partial: false, results })),
            );
            // Both attempts, owner decoding and the independent result permission check share the request deadline.
            return yield* operation.pipe(Effect.retry({ times: 1 }), Effect.provideContext(environment));
          },
          (program) => withShellSearchRequestBudget(program, unavailable),
        ),
      };
    }),
  );

const resultKey = (row: ShellSearchResponse['results'][number]) =>
  `${row.ref.tenantId ?? ''}:${row.ref.moduleId}:${row.ref.resourceType}:${row.ref.resourceId}`;
export const mergeShellSystemSearch = Effect.fn('ShellSystemSearch.merge')(
  function* merge(
    business: Effect.Effect<ShellSearchResponse, ShellProviderUnavailableError>,
    system: Effect.Effect<ShellSearchResponse, ShellProviderUnavailableError>,
    presentation?: ShellSearchPresentationInventory,
  ) {
    const outcomes = yield* Effect.all(
      [
        Effect.result(
          business.pipe(
            observeShellSearchProvider({
              moduleId: 'shell.super-app',
              phase: 'owner',
              searchKey: 'shell.super-app.business-search',
            }),
          ),
        ),
        Effect.result(
          system.pipe(
            observeShellSearchProvider({
              moduleId: 'core.identity',
              phase: 'owner',
              searchKey: 'core.identity.people',
            }),
          ),
        ),
      ],
      { concurrency: 2 },
    );
    const successes = outcomes.flatMap((outcome) => (Result.isSuccess(outcome) ? [outcome.success] : []));
    // A failed branch or a partial business answer leaves the other results visible as a partial answer; only an
    // answer where no branch answered is unavailable.
    if (successes.length === 0) {
      return yield* unavailable();
    }
    const partial = successes.length !== outcomes.length || successes.some((success) => success.partial);
    const [businessOutcome] = outcomes;
    const businessPresentation =
      businessOutcome !== undefined && Result.isSuccess(businessOutcome)
        ? businessOutcome.success.presentation
        : undefined;
    if (
      presentation !== undefined &&
      businessPresentation !== undefined &&
      presentation.business.compositionRevision !== businessPresentation.business.compositionRevision
    ) {
      return yield* unavailable();
    }
    // The governed caller supplies the exact Core-owned system declaration; raw result bodies never supply it.
    const capturedPresentation = presentation ?? businessPresentation;
    const rows = new Map(successes.flatMap(({ results }) => results.map((row) => [resultKey(row), row] as const)));
    const response = {
      partial,
      results: sortShellSearchResults([...rows.values()]),
    };
    return yield* Schema.decodeUnknownEffect(ShellSearchResponseSchema)(
      capturedPresentation === undefined ? response : { ...response, presentation: capturedPresentation },
    ).pipe(Effect.mapError(unavailable));
  },
  (program) => withShellSearchRequestBudget(program, unavailable),
);
