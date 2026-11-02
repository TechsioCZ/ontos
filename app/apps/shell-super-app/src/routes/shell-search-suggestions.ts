import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { useRef, useState } from 'react';

import type { ShellSearchResult } from '../../shared/api.ts';
import { searchResources } from '../api/auth-client.ts';
import type { ShellSearchClientError } from '../api/auth-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { shellSearchGroupOf, shellSearchGroupOrder, shellSearchLinkTarget } from './shell-search-resource-types.ts';
import type { ShellSearchGroupKey, ShellSearchLinkTarget } from './shell-search-resource-types.ts';

type PartyRole = Extract<ShellSearchResult, { readonly kind: 'counterparty' }>['currentRoles'][number];

export interface ShellSearchSuggestion {
  readonly archived: boolean;
  readonly key: string;
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

const resultKey = ({ moduleId, resourceId, resourceType }: ShellSearchResult['ref']) =>
  `${moduleId}:${resourceType}:${resourceId}`;

const toSuggestion = (result: ShellSearchResult): ShellSearchSuggestion => {
  if (result.kind === 'counterparty') {
    return {
      archived: result.party.archived,
      key: resultKey(result.ref),
      roles: result.currentRoles,
      target: shellSearchLinkTarget(result.ref, result.title),
      title: result.title,
    };
  }
  return {
    archived: result.kind === 'party' && result.archived,
    key: resultKey(result.ref),
    roles: [],
    target: shellSearchLinkTarget(result.ref, result.title),
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
    results.flatMap((result) => (result.kind === 'counterparty' ? [resultKey(result.party.ref)] : [])),
  );
  const visible = results.filter(
    (result) => result.kind !== 'party' || !partiesWithRelationship.has(resultKey(result.ref)),
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

/**
 * Typeahead for the top-bar search. Each change cancels the previous request; the request leaves only after a short
 * pause in typing, so a burst of keystrokes costs one search.
 */
export const useShellSearchSuggestions = (compositionRevision: string | undefined) => {
  const { language } = useModernI18n();
  const [state, setState] = useState<ShellSearchSuggestionsState>({ status: 'idle' });
  const pending = useRef<AbortController | null>(null);

  const cancel = () => {
    pending.current?.abort();
    pending.current = null;
  };

  const handleQueryChange = (value: string) => {
    cancel();
    const query = value.trim();
    if (compositionRevision === undefined || query.length < SUGGESTION_MINIMUM_QUERY_LENGTH) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setState({ query, status: 'loading' });
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
            if (pending.current === controller) {
              setState(next);
            }
          }),
        ),
      ),
      { signal: controller.signal },
    );
  };

  const handleDismiss = () => {
    cancel();
    setState({ status: 'idle' });
  };

  return { handleDismiss, handleQueryChange, state };
};
