import { ContextAccess } from '@app/core-runtime';
import {
  runPeopleSearch,
  PeopleSearchResponseSchema,
  personIdentity,
  corePeopleSystemSearchProvider,
} from '@app/core-runtime/people/search';
import type { PeopleSearchResponse, PeopleSearchRequirements } from '@app/core-runtime/people/search';
import { Context, Effect, Layer, Option, Result, Schema } from 'effect';
import { ShellSearchResponseSchema } from '../../shared/api.ts';
import type { ShellSearchResponse } from '../../shared/api.ts';
import { ShellProviderUnavailableError } from './shell-resources.ts';
import type { ShellResourceContext } from './shell-resources.ts';
import { observeShellSearchProvider } from './shell-search-diagnostics.ts';

type UnparsedSystemSearchResults = typeof Schema.Unknown.Type;
const unavailable = (cause?: unknown) => new ShellProviderUnavailableError(cause === undefined ? {} : { cause });
/** Core remains outside the installed business-module catalog. This branch admits one exact system contract. */
export const authorizePeopleSearchResults: (
  scope: ShellResourceContext,
  values: UnparsedSystemSearchResults,
) => Effect.Effect<ShellSearchResponse['results'], ShellProviderUnavailableError, ContextAccess> = Effect.fn(
  'ShellSystemSearch.authorizePeopleResults',
)(function* authorize(scope: ShellResourceContext, values: UnparsedSystemSearchResults) {
  const decoded: PeopleSearchResponse = yield* Schema.decodeUnknownEffect(PeopleSearchResponseSchema, {
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
  const access = yield* ContextAccess;
  const decisions = yield* access.resources({
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    resources: scoped.map(({ ref }) => ref),
    tenantId: scope.tenantId,
  });
  if (
    decisions.length !== scoped.length ||
    decisions.some((decision, index) => {
      const row = scoped[index];
      return (
        row === undefined ||
        decision.decision === 'unavailable' ||
        decision.key !== `${row.ref.moduleId}:${row.ref.resourceType}:${row.ref.resourceId}`
      );
    })
  ) {
    return yield* unavailable();
  }
  const results = scoped.flatMap((row, index) =>
    decisions[index]?.decision === 'allowed' ? [{ ...row, kind: 'resource' as const }] : [],
  );
  const response = yield* Schema.decodeUnknownEffect(ShellSearchResponseSchema)({ partial: false, results }).pipe(
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
export const ShellPeopleSystemSearchLive: Layer.Layer<
  ShellSystemSearch,
  never,
  PeopleSearchRequirements | ContextAccess
> = Layer.effect(
  ShellSystemSearch,
  Effect.gen(function* live() {
    const environment = yield* Effect.context<Effect.Services<ReturnType<typeof runPeopleSearch>> | ContextAccess>();
    return {
      search: Effect.fn('ShellSystemSearch.people')(function* search(scope: ShellResourceContext, query: string) {
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
        return yield* operation.pipe(Effect.retry({ times: 1 }), Effect.provideContext(environment));
      }),
    };
  }),
);

const resultKey = (row: ShellSearchResponse['results'][number]) =>
  `${row.ref.moduleId}:${row.ref.resourceType}:${row.ref.resourceId}`;
export const mergeShellSystemSearch = Effect.fn('ShellSystemSearch.merge')(function* merge(
  business: Effect.Effect<ShellSearchResponse, ShellProviderUnavailableError>,
  system: Effect.Effect<ShellSearchResponse, ShellProviderUnavailableError>,
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
  if (successes.length !== outcomes.length || successes.some(({ partial }) => partial)) {
    return yield* unavailable();
  }
  const rows = new Map(successes.flatMap(({ results }) => results.map((row) => [resultKey(row), row] as const)));
  return {
    partial: false,
    results: [...rows.values()].toSorted(
      (left, right) => left.title.localeCompare(right.title) || resultKey(left).localeCompare(resultKey(right)),
    ),
  } as const;
});
