import { useHeldSnapshot } from '@app/admin-ui';
import { pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps, PageData, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { useEffect, useSyncExternalStore } from 'react';

/** The legal entity a page's data belongs to; '' outside the Shell (the standalone vertical app). */
export const legalEntityOf = (props: Partial<ModulePageProps>): string => props.context?.legalEntityId ?? '';

/**
 * Reads the legal entity's entry of a workforce page dataset synchronously. Under the Shell, `preloadPage` filled it
 * before the page was revealed; a cold mount the Shell could not prepare loads it once.
 *
 * A background reload of the same entry keeps its last ready value on screen, so an open employee panel keeps its
 * write access, account choices and revision while a strict dataset reloads. A failed or refused reload, or another
 * legal entity, replaces it at once.
 */
export const usePageData = <A, E>(data: PageData<string, A, E>, legalEntityId: string): PageDataSnapshot<A, E> => {
  const snapshot = useHeldSnapshot(
    data.key(legalEntityId),
    useSyncExternalStore(
      data.subscribe,
      () => data.snapshot(legalEntityId),
      () => pageDataPending,
    ),
  );
  useEffect(() => data.ensure(legalEntityId), [data, legalEntityId]);
  return snapshot;
};
