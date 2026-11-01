import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Schema } from 'effect';
import { useRef, useState } from 'react';

import type { ShellSearchResult } from '../../shared/api.ts';
import { searchResources } from '../api/auth-client.ts';
import type { ShellSearchClientError } from '../api/auth-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';

export const ShellSearchSuggestionGroupKeySchema = Schema.Literals(['counterparty', 'party', 'resource']);
export type ShellSearchSuggestionGroupKey = typeof ShellSearchSuggestionGroupKeySchema.Type;
type PartyRole = Extract<ShellSearchResult, { readonly kind: 'counterparty' }>['currentRoles'][number];

export interface ShellSearchSuggestion {
  readonly archived: boolean;
  readonly key: string;
  readonly ref: ShellSearchResult['ref'];
  readonly roles: readonly PartyRole[];
  readonly title: string;
}

export interface ShellSearchSuggestionGroup {
  readonly key: ShellSearchSuggestionGroupKey;
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
const groupOrder = ShellSearchSuggestionGroupKeySchema.literals;

const resultKey = ({ moduleId, resourceId, resourceType }: ShellSearchResult['ref']) =>
  `${moduleId}:${resourceType}:${resourceId}`;

const toSuggestion = (result: ShellSearchResult): ShellSearchSuggestion => {
  if (result.kind === 'counterparty') {
    return {
      archived: result.party.archived,
      key: resultKey(result.ref),
      ref: result.ref,
      roles: result.currentRoles,
      title: result.title,
    };
  }
  return {
    archived: result.kind === 'party' && result.archived,
    key: resultKey(result.ref),
    ref: result.ref,
    roles: [],
    title: result.title,
  };
};

/**
 * Groups results by kind in a fixed order. A Party already shown through its customer or supplier relationship in the
 * selected company is not repeated as a contact.
 */
export const groupShellSearchResults = (
  results: readonly ShellSearchResult[],
  perGroup = SUGGESTIONS_PER_GROUP,
): readonly ShellSearchSuggestionGroup[] => {
  const partiesWithRelationship = new Set(
    results.flatMap((result) => (result.kind === 'counterparty' ? [resultKey(result.party.ref)] : [])),
  );
  const visible = results.filter(
    (result) => result.kind !== 'party' || !partiesWithRelationship.has(resultKey(result.ref)),
  );
  return groupOrder.flatMap((key) => {
    const members = visible.filter((result) => result.kind === key);
    return members.length === 0
      ? []
      : [{ key, suggestions: members.slice(0, perGroup).map(toSuggestion), total: members.length }];
  });
};

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
            groups: groupShellSearchResults(response.results),
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
