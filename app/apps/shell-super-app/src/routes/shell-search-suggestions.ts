import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Predicate } from 'effect';
import { useEffect, useRef, useState } from 'react';

import type { ShellSearchResult } from '../../shared/api.ts';
import { searchResources } from '../api/auth-client.ts';
import type { ShellSearchClientError } from '../api/auth-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { planShellSearchFilters, shellSearchFamiliesInOrder, shellSearchResultKey } from './shell-search-match.ts';
import type { ShellSearchFilterPlan } from './shell-search-match.ts';
import {
  shellSearchGroupOf,
  shellSearchPresentationIndex,
  shellSearchResultTarget,
} from './shell-search-resource-types.ts';
import type {
  ShellSearchGroupPresentation,
  ShellSearchLinkTarget,
  ShellSearchPresentationIndex,
} from './shell-search-resource-types.ts';

type PartyRole = Extract<ShellSearchResult, { readonly kind: 'counterparty' }>['currentRoles'][number];

export interface ShellSearchSuggestion {
  readonly archived: boolean;
  readonly key: string;
  /** The hit as the provider returned it, so one shared result row renders the real record and its badges. */
  readonly result: ShellSearchResult;
  readonly roles: readonly PartyRole[];
  /** Where the hit opens: its owner's record page, else the Shell record page. */
  readonly target: ShellSearchLinkTarget;
  /** The hit's own governed title; absent when the caller may not see the name (O17, O58). */
  readonly title: string | undefined;
}

export interface ShellSearchResultGroup<Item> {
  readonly items: readonly Item[];
  readonly presentation: ShellSearchGroupPresentation;
}

export interface ShellSearchSuggestionGroup {
  readonly presentation: ShellSearchGroupPresentation;
  readonly suggestions: readonly ShellSearchSuggestion[];
  /** All matches of the group; the typeahead shows the first few. */
  readonly total: number;
}

export type ShellSearchSuggestionFilters = Pick<ShellSearchFilterPlan, 'availableFamilies' | 'selectedFamilies'>;

export type ShellSearchSuggestionsState =
  | { readonly status: 'idle' }
  | { readonly filters: ShellSearchSuggestionFilters; readonly query: string; readonly status: 'loading' }
  | {
      readonly failure: ShellSearchClientError;
      readonly filters: ShellSearchSuggestionFilters;
      readonly query: string;
      readonly status: 'unavailable';
    }
  /** The person's Roles do not include search here: said plainly, and not asked again in this scope. */
  | { readonly filters: ShellSearchSuggestionFilters; readonly query: string; readonly status: 'forbidden' }
  | {
      readonly filters: ShellSearchSuggestionFilters;
      readonly groups: readonly ShellSearchSuggestionGroup[];
      readonly index?: ShellSearchPresentationIndex;
      readonly partial: boolean;
      readonly query: string;
      readonly status: 'ready';
    };

/** Shorter queries match too much to be useful while typing; Enter still searches them on the results page. */
export const SUGGESTION_MINIMUM_QUERY_LENGTH = 2;
const SUGGESTIONS_PER_GROUP = 5;

const toSuggestion = (
  result: ShellSearchResult,
  index: ShellSearchPresentationIndex | undefined,
): ShellSearchSuggestion => {
  const key = shellSearchResultKey(result);
  const target = shellSearchResultTarget(result, index);
  if (result.kind === 'counterparty') {
    return {
      archived: result.party.archived,
      key,
      result,
      roles: result.currentRoles,
      target,
      title: result.title,
    };
  }
  return {
    archived: result.kind === 'party' && result.archived,
    key,
    result,
    roles: [],
    target,
    title: result.title,
  };
};

/**
 * Groups results by what they are (the owner's resource type) in a fixed group order, keeping the search's own order
 * inside each group. A Party already shown through its customer or supplier relationship in the selected company is
 * not repeated as a contact.
 */
export const groupShellSearchResults = (
  results: readonly ShellSearchResult[],
  index: ShellSearchPresentationIndex | undefined,
): readonly ShellSearchResultGroup<ShellSearchResult>[] => {
  const partiesWithRelationship = new Set(
    results.flatMap((result) => (result.kind === 'counterparty' ? [shellSearchResultKey(result.party)] : [])),
  );
  const visible = results.filter(
    (result) => result.kind !== 'party' || !partiesWithRelationship.has(shellSearchResultKey(result)),
  );
  const groups = new Map<
    string,
    { readonly items: ShellSearchResult[]; readonly presentation: ShellSearchGroupPresentation }
  >();
  for (const result of visible) {
    const presentation = shellSearchGroupOf(result, index);
    const current = groups.get(presentation.key);
    if (current === undefined) {
      groups.set(presentation.key, { items: [result], presentation });
    } else {
      current.items.push(result);
    }
  }
  return [...groups.values()].toSorted(
    (left, right) =>
      left.presentation.order - right.presentation.order || left.presentation.key.localeCompare(right.presentation.key),
  );
};

/** The typeahead's groups: the first few hits of each. */
export const groupShellSearchSuggestions = (
  results: readonly ShellSearchResult[],
  index: ShellSearchPresentationIndex | undefined,
  perGroup = SUGGESTIONS_PER_GROUP,
): readonly ShellSearchSuggestionGroup[] =>
  groupShellSearchResults(results, index).map(({ items, presentation }) => ({
    presentation,
    suggestions: items.slice(0, perGroup).map((result) => toSuggestion(result, index)),
    total: items.length,
  }));

const idleSuggestionsState: ShellSearchSuggestionsState = { status: 'idle' };
const emptyFilters: ShellSearchSuggestionFilters = { availableFamilies: [], selectedFamilies: [] };

interface PendingSuggestionRequest {
  readonly controller: AbortController;
  readonly scope: string;
}

interface ScopedSuggestionState {
  readonly scope: string;
  readonly state: ShellSearchSuggestionsState;
}

/** The trusted Shell scope key and the reader's language jointly name the answer an in-flight search belongs to. */
const suggestionScopeKey = (
  scopeKey: string,
  compositionRevision: string | undefined,
  language: string | undefined,
): string => `${scopeKey}\u0000${compositionRevision ?? ''}\u0000${language ?? ''}`;

/**
 * Typeahead for the top-bar search. Each change cancels the previous request; the request leaves only after a short
 * pause in typing, so a burst of keystrokes costs one search. A new trusted scope (tenant, company, principal,
 * composition or language) is different: its answer is dropped before paint, the old request is aborted, and its
 * filters are cleared. Selecting a family performs a fresh search with only the exact observed admitted types; it
 * never filters an answer already received.
 */
export const useShellSearchSuggestions = (compositionRevision: string | undefined, scopeKey: string | undefined) => {
  const { language } = useModernI18n();
  const scope = suggestionScopeKey(scopeKey ?? 'missing-principal', compositionRevision, language);
  const [scoped, setScoped] = useState<ScopedSuggestionState>(() => ({ scope, state: idleSuggestionsState }));
  const pending = useRef<PendingSuggestionRequest | null>(null);
  // Adjust state while rendering, before an answer from the previous scope can ever paint.
  if (scoped.scope !== scope) {
    setScoped({ scope, state: idleSuggestionsState });
  }
  const state = scoped.scope === scope ? scoped.state : idleSuggestionsState;

  const cancel = () => {
    pending.current?.controller.abort();
    pending.current = null;
  };

  const apply = (next: ShellSearchSuggestionsState) => {
    setScoped({ scope, state: next });
  };

  const runSearch = (query: string, requestedFamilies: readonly string[]) => {
    cancel();
    if (compositionRevision === undefined || scopeKey === undefined || query.length < SUGGESTION_MINIMUM_QUERY_LENGTH) {
      apply(idleSuggestionsState);
      return;
    }
    // Search is a right of its own; once this scope refused it, typing asks nothing more.
    if (state.status === 'forbidden') {
      apply({ filters: state.filters, query, status: 'forbidden' });
      return;
    }
    const controller = new AbortController();
    const requestScope = scope;
    const previous = scoped.scope === scope && scoped.state.status !== 'idle' ? scoped.state : undefined;
    const previousFilters = previous !== undefined && previous.query === query ? previous.filters : emptyFilters;
    const selectedFamilies = shellSearchFamiliesInOrder(
      requestedFamilies,
      previousFilters.availableFamilies.map(({ family }) => family),
    );
    const loadingFilters: ShellSearchSuggestionFilters = {
      availableFamilies: previousFilters.availableFamilies,
      selectedFamilies,
    };
    pending.current = { controller, scope: requestScope };
    apply({ filters: loadingFilters, query, status: 'loading' });
    // A family filter can only name exact owner types after the admitted inventory arrives, so its first request asks
    // for the inventory alone (zero owner dispatch); an unknown or malformed selection never widens to an unfiltered
    // answer. An empty selection keeps the single real unfiltered request.
    const firstPayload =
      requestedFamilies.length === 0
        ? { compositionRevision, query }
        : { compositionRevision, query, resourceTypes: [] };
    void browserRuntime.runPromiseExit(
      searchResources(firstPayload, { locale: language ?? '' }).pipe(
        Effect.flatMap((first) => {
          const index = shellSearchPresentationIndex(first.presentation, compositionRevision);
          const plan = planShellSearchFilters({ index, partial: first.partial, requestedFamilies });
          if (requestedFamilies.length === 0) {
            return Effect.succeed({ index, plan, response: first });
          }
          if (plan.resourceTypes === undefined || plan.resourceTypes.length === 0) {
            const emptyResponse =
              first.presentation === undefined
                ? { partial: first.partial, results: [] }
                : { partial: first.partial, presentation: first.presentation, results: [] };
            return Effect.succeed({ index, plan, response: emptyResponse });
          }
          return searchResources(
            { compositionRevision, query, resourceTypes: plan.resourceTypes },
            { locale: language ?? '' },
          ).pipe(
            // The canonical inventory index stays authoritative, so a selected-only answer never shrinks the filters.
            Effect.map((response) => ({ index, plan, response })),
          );
        }),
        Effect.match({
          onFailure: (error): ShellSearchSuggestionsState =>
            Predicate.isTagged(error, 'ShellTargetForbiddenProblem')
              ? { filters: emptyFilters, query, status: 'forbidden' }
              : { failure: error, filters: loadingFilters, query, status: 'unavailable' },
          onSuccess: ({ index, plan, response }): ShellSearchSuggestionsState => {
            const ready = {
              filters: {
                availableFamilies: plan.availableFamilies,
                selectedFamilies: plan.selectedFamilies,
              },
              groups: groupShellSearchSuggestions(response.results, index),
              partial: response.partial,
              query,
              status: 'ready' as const,
            };
            return index === undefined ? ready : { ...ready, index };
          },
        }),
        Effect.flatMap((next) =>
          Effect.sync(() => {
            if (pending.current?.controller === controller) {
              setScoped({ scope: requestScope, state: next });
            }
          }),
        ),
      ),
      { signal: controller.signal },
    );
  };

  const handleQueryChange = (value: string) => {
    runSearch(value.trim(), []);
  };

  const handleFamiliesChange = (families: readonly string[]) => {
    const query = state.status === 'idle' ? '' : state.query;
    if (query.length >= SUGGESTION_MINIMUM_QUERY_LENGTH) {
      runSearch(query, families);
    }
  };

  const handleDismiss = () => {
    cancel();
    apply(idleSuggestionsState);
  };

  // The derived state already hides the previous answer; this releases the request that produced it.
  useEffect(() => {
    const request = pending.current;
    if (request !== null && request.scope !== scope) {
      request.controller.abort();
      pending.current = null;
    }
  }, [scope]);

  // Leaving the header (sign-out, navigation) must not leave a request running or apply its answer afterwards.
  useEffect(
    () => () => {
      pending.current?.controller.abort();
      pending.current = null;
    },
    [],
  );

  return { handleDismiss, handleFamiliesChange, handleQueryChange, state };
};
