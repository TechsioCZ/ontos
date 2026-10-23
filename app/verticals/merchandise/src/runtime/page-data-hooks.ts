import type { ModulePageContext, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { useState } from 'react';

/** The legal entity a page's data belongs to; '' outside the Shell (the standalone vertical app). */
export const legalEntityOf = (props: { readonly context?: ModulePageContext | undefined }): string =>
  props.context?.legalEntityId ?? '';

export interface SettledPageData<I, A, E> {
  /** The input this entry answers; differs from the current input while a new one loads. */
  readonly input: I;
  readonly snapshot: Exclude<PageDataSnapshot<A, E>, { readonly state: 'pending' }>;
}

/** The entry for `input` once settled; while a new input (filter, page) loads, the last settled entry stays. */
export const useSettledPageData = <I, A, E>(
  snapshot: PageDataSnapshot<A, E>,
  input: I,
): SettledPageData<I, A, E> | undefined => {
  const [last, setLast] = useState<SettledPageData<I, A, E>>();
  if (snapshot.state === 'pending') {
    return last;
  }
  // Snapshots are stable per entry state, so this stores each settled state once.
  if (last?.snapshot !== snapshot) {
    setLast({ input, snapshot });
  }
  return { input, snapshot };
};
