import { foldSearchText } from '@app/admin-ui';
import { listCustomers } from '@app/party-registry/api/client';
import type { CustomerListItem } from '@app/party-registry/api/client';
import { definePageData, pageDataPending } from '@app/shared-contracts/page-data';
import type { PageDataSnapshot } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { useEffect, useSyncExternalStore } from 'react';
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

const toEntry = (item: CustomerListItem): CustomerEntry => ({
  companyId: item.companyId ?? null,
  name: item.displayName ?? null,
  partyId: item.partyId,
  status: item.status,
});

/** The company's customers from party-registry, archived ones included; one entry per legal entity and document. */
export const customerDirectoryData = definePageData({
  key: (legalEntityId: string) => legalEntityId,
  load: () => listCustomers({ includeArchived: true, limit: 500 }).pipe(Effect.map((items) => items.map(toEntry))),
  runtime: browserRuntime,
});

const NO_ENTRIES: readonly CustomerEntry[] = [];

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

const directoryStatus = (snapshot: PageDataSnapshot<unknown, unknown>): CustomerDirectory['status'] => {
  if (snapshot.state === 'ready') {
    return 'ready';
  }
  return snapshot.state === 'failed' && !snapshot.refreshing ? 'error' : 'loading';
};

/**
 * The customer list order names and the customer picker both read. Disabled (dispatch has no directory access) it
 * reads nothing and counts as ready. The orders page prepares it with its first page.
 */
export const useCustomerDirectory = (legalEntityId: string, enabled = true): CustomerDirectory => {
  const snapshot = useSyncExternalStore(
    customerDirectoryData.subscribe,
    () => customerDirectoryData.snapshot(legalEntityId),
    () => pageDataPending,
  );
  useEffect(() => {
    if (enabled) {
      customerDirectoryData.ensure(legalEntityId);
    }
  }, [enabled, legalEntityId]);
  const entries = snapshot.state === 'ready' ? snapshot.value : NO_ENTRIES;
  const byId = new Map(entries.map((entry) => [entry.partyId, entry] as const));
  return {
    active: entries.filter((entry) => entry.status === 'ACTIVE'),
    entries,
    nameOf: (partyId) => byId.get(partyId)?.name ?? null,
    reload: () => {
      if (enabled) {
        browserRuntime.runFork(customerDirectoryData.refresh(legalEntityId));
      }
    },
    status: enabled ? directoryStatus(snapshot) : 'ready',
  };
};
