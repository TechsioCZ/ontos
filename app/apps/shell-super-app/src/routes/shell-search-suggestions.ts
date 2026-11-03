import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { useEffect, useRef, useState } from 'react';

import type { ShellSearchResult } from '../../shared/api.ts';
import { searchResources } from '../api/auth-client.ts';
import type { ShellSearchClientError } from '../api/auth-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { shellSearchResultKey } from './shell-search-match.ts';
import { shellSearchGroupOf, shellSearchGroupOrder, shellSearchResultTarget } from './shell-search-resource-types.ts';
import type { ShellSearchGroupKey, ShellSearchLinkTarget } from './shell-search-resource-types.ts';

type PartyRole = Extract<ShellSearchResult, { readonly kind: 'counterparty' }>['currentRoles'][number];

export interface ShellSearchSuggestion {
  readonly archived: boolean;
  readonly key: string;
  /** The hit as the provider returned it, so one shared result row renders the real record and its badges. */
  readonly result: ShellSearchResult;
  readonly roles: readonly PartyRole[];
  /** Where the hit opens: its owner's record page, else the Shell record page. */
  readonly target: ShellSearchLinkTarget;
  readonly title: string;
}

export interface ShellSearchResultGroup<Item> {
  readonly items: readonly Item[];
  readonly key: ShellSearchGroupKey;
}

export interface ShellSearchSuggestionGroup {
  readonly key: ShellSearchGroupKey;
  readonly suggestions: readonly ShellSearchSuggestion[];
  /** All matches of the group; the typeahead shows the first few. */
  readonly total: number;
}

export type ShellSearchSuggestionsState =
  | { readonly status: 'idle' }
  | { readonly query: string; readonly status: 'loading' }
  | { readonly failure: ShellSearchClientError; readonly query: string; readonly status: 'unavailable' }
  | {
      readonly groups: readonly ShellSearchSuggestionGroup[];
      readonly partial: boolean;
      readonly query: string;
      readonly status: 'ready';
    };

/** Shorter queries match too much to be useful while typing; Enter still searches them on the results page. */
export const SUGGESTION_MINIMUM_QUERY_LENGTH = 2;
const SUGGESTIONS_PER_GROUP = 5;

const toSuggestion = (result: ShellSearchResult): ShellSearchSuggestion => {
  const key = shellSearchResultKey(result);
  const target = shellSearchResultTarget(result);
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
): readonly ShellSearchResultGroup<ShellSearchResult>[] => {
  const partiesWithRelationship = new Set(
    results.flatMap((result) => (result.kind === 'counterparty' ? [shellSearchResultKey(result.party)] : [])),
  );
  const visible = results.filter(
    (result) => result.kind !== 'party' || !partiesWithRelationship.has(shellSearchResultKey(result)),
  );
  return shellSearchGroupOrder.flatMap((key) => {
    const items = visible.filter((result) => shellSearchGroupOf(result) === key);
    return items.length === 0 ? [] : [{ items, key }];
  });
};

/** The typeahead's groups: the first few hits of each. */
export const groupShellSearchSuggestions = (
  results: readonly ShellSearchResult[],
  perGroup = SUGGESTIONS_PER_GROUP,
): readonly ShellSearchSuggestionGroup[] =>
  groupShellSearchResults(results).map(({ items, key }) => ({
    key,
    suggestions: items.slice(0, perGroup).map(toSuggestion),
    total: items.length,
  }));

const idleSuggestionsState: ShellSearchSuggestionsState = { status: 'idle' };

interface PendingSuggestionRequest {
  readonly controller: AbortController;
  readonly scope: string;
}

interface ScopedSuggestionState {
  readonly scope: string;
  readonly state: ShellSearchSuggestionsState;
}

/** Composition revision and language jointly name the search scope an answer belongs to. */
const suggestionScopeKey = (compositionRevision: string | undefined, language: string | undefined): string =>
  `${compositionRevision ?? ''}\u0000${language ?? ''}`;

/**
 * Typeahead for the top-bar search. Each change cancels the previous request; the request leaves only after a short
 * pause in typing, so a burst of keystrokes costs one search. A new composition revision or language is a different
 * scope: its answer is dropped before paint, and the request that belonged to the old scope is aborted.
 */
export const useShellSearchSuggestions = (compositionRevision: string | undefined) => {
  const { language } = useModernI18n();
  const scope = suggestionScopeKey(compositionRevision, language);
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

  const handleQueryChange = (value: string) => {
    cancel();
    const query = value.trim();
    if (compositionRevision === undefined || query.length < SUGGESTION_MINIMUM_QUERY_LENGTH) {
      apply(idleSuggestionsState);
      return;
    }
    const controller = new AbortController();
    const requestScope = scope;
    pending.current = { controller, scope: requestScope };
    apply({ query, status: 'loading' });
    void browserRuntime.runPromiseExit(
      Effect.sleep('200 millis').pipe(
        Effect.andThen(searchResources({ compositionRevision, query }, { locale: language ?? '' })),
        Effect.match({
          onFailure: (error): ShellSearchSuggestionsState => ({ failure: error, query, status: 'unavailable' }),
          onSuccess: (response): ShellSearchSuggestionsState => ({
            groups: groupShellSearchSuggestions(response.results),
            partial: response.partial,
            query,
            status: 'ready',
          }),
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

  return { handleDismiss, handleQueryChange, state };
};
