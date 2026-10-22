import { foldSearchText } from '@app/admin-ui';
import { listCustomers } from '@app/party-registry/api/client';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

export interface CustomerEntry {
  /** Company registration number (IČO) as the party registry holds it, when present. */
  readonly companyId: string | null;
  readonly name: string | null;
  readonly partyId: string;
  readonly status: 'ACTIVE' | 'ARCHIVED';
}

export interface CustomerDirectory {
  /** Active customers only: the choices for a new order. */
  readonly active: readonly CustomerEntry[];
  /** Every loaded customer, archived ones included (the same array until the directory reloads). */
  readonly entries: readonly CustomerEntry[];
  /** Display name for any partyId, archived customers included, so old orders keep their names. */
  readonly nameOf: (partyId: string) => string | null;
  readonly reload: () => void;
  readonly status: 'loading' | 'ready' | 'error';
}

interface DirectoryState {
  readonly entries: readonly CustomerEntry[];
  /** The failure that left the directory empty, kept for diagnosis. */
  readonly failure?: unknown;
  readonly status: 'loading' | 'ready' | 'error';
}

const loadInto = (setState: (next: DirectoryState) => void): void => {
  void browserRuntime.runPromise(
    listCustomers({ includeArchived: true, limit: 500 }).pipe(
      Effect.match({
        onFailure: (failure) => setState({ entries: [], failure, status: 'error' }),
        onSuccess: (items) =>
          setState({
            entries: items.map((item) => ({
              companyId: item.companyId ?? null,
              name: item.displayName ?? null,
              partyId: item.partyId,
              status: item.status,
            })),
            status: 'ready',
          }),
      }),
    ),
  );
};

const WORD_SEPARATORS = /\s+/u;

/**
 * Party ids of the customers whose name contains every word of `search` (case- and diacritics-insensitive): the
 * bounded customer lookup the order search sends along, since staff orders store the party, not its name.
 */
export const customersMatching = (entries: readonly CustomerEntry[], search: string): readonly string[] => {
  const words = foldSearchText(search.trim())
    .split(WORD_SEPARATORS)
    .filter((word) => word !== '');
  if (words.length === 0) {
    return [];
  }
  return entries.flatMap((entry) => {
    const name = foldSearchText(entry.name ?? '');
    return name !== '' && words.every((word) => name.includes(word)) ? [entry.partyId] : [];
  });
};

/** Loads the customer list from party-registry once. Order names and the customer picker both read it. */
export const useCustomerDirectory = (enabled = true): CustomerDirectory => {
  const [state, setState] = useState<DirectoryState>({ entries: [], status: 'loading' });
  useEffect(() => {
    if (enabled) {
      loadInto(setState);
    }
  }, [enabled]);
  const byId = new Map(state.entries.map((entry) => [entry.partyId, entry] as const));
  return {
    active: state.entries.filter((entry) => entry.status === 'ACTIVE'),
    entries: state.entries,
    nameOf: (partyId) => byId.get(partyId)?.name ?? null,
    reload: () => {
      setState((current) => ({ ...current, status: 'loading' }));
      if (enabled) {
        loadInto(setState);
      }
    },
    status: enabled ? state.status : 'ready',
  };
};
