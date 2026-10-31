import { pageDataPending } from '@app/shared-contracts/page-data';
import type { PageData, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Reads the legal entity's entry of a agent page dataset synchronously. Under the Shell, `preloadPage` filled it
 * before the page was revealed; a cold mount the Shell could not prepare loads it once.
 */
export const usePageData = <A, E>(data: PageData<string, A, E>, legalEntityId: string): PageDataSnapshot<A, E> => {
  const snapshot = useSyncExternalStore(
    data.subscribe,
    () => data.snapshot(legalEntityId),
    () => pageDataPending,
  );
  useEffect(() => data.ensure(legalEntityId), [data, legalEntityId]);
  return snapshot;
};
